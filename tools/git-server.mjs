#!/usr/bin/env node
//
// GitMenorah Git server: serves `git.html` and the /api/git/* routes it calls.
//
//   node tools/git-server.mjs              # http://127.0.0.1:4990
//   node tools/git-server.mjs --port=5000
//   node tools/git-server.mjs --open       # also open the browser (macOS)
//
// The desktop app (git-desktop/main.cjs) runs this file on a free 127.0.0.1 port and shows
// the page in its Git tab. Another local server can mount the same routes instead:
//   import { gitRoute, loadGitConf } from './git-server.mjs';
//   await loadGitConf();  …  if (await gitRoute(req, res, url)) return;
//
// Repositories, project groups and git cloud accounts the user adds are stored in
// ~/.config/gitmenorah/git.json (outside any repo). Override the location with GITMENORAH_CONF=<file>.
// Account tokens are not in that file: they go to git's own credential helper (Keychain…).
//
// SAFETY: this is "run git on my machine" over HTTP, so:
//   • listen on 127.0.0.1 only and reject unknown Host headers (DNS rebinding);
//   • POST needs the `X-Dev-Runner` header: another site sending it triggers a CORS
//     preflight, and this server answers no CORS, so the browser blocks it;
//   • requests never carry a path to run in: repositories, worktrees, branches and remotes
//     must match the lists the server reads itself. Rules are in the "Git" section below.
// The server reads no env files.

import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { open, readFile, readdir, realpath, stat, lstat, mkdir, writeFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const PAGE = join(TOOLS, 'git.html');
const WORKTREE_RE = /^(?![.-])[A-Za-z0-9._-]+$/;   // worktree folder name: no leading . or -

// Run a command, resolve its stdout (null when it failed and printed nothing).
function sh(cmd, args) {
  return new Promise((done) => execFile(cmd, args, { timeout: 4000 }, (e, so) => done(e && !so ? null : so)));
}

// ─── Settings ──────────────────────────────────────────────────────────────
// { extra: [repo dir], groups: [{ id, name, path, repos, addedAt }], linkNodeModules,
//   accounts: [{ id, service, host, username, email, name, protocol, addedAt }], cloneDir }
// `linkNodeModules`: a new worktree gets symlinks to the main worktree's node_modules
// (every folder with a tracked package.json). Off by default — npm install inside the
// worktree would then write into the main worktree's packages.
const CONF_FILE = process.env.GITMENORAH_CONF || join(homedir(), '.config', 'gitmenorah', 'git.json');
let linkDeps = false;

export async function loadGitConf() {
  try {
    const c = JSON.parse(await readFile(CONF_FILE, 'utf8'));
    if (Array.isArray(c.extra)) gitExtra = c.extra.filter((p) => typeof p === 'string' && isAbsolute(p));
    if (Array.isArray(c.groups)) {
      gitGroups = c.groups.filter((g) => g && typeof g.id === 'string' && typeof g.name === 'string' && typeof g.path === 'string' && isAbsolute(g.path))
        .map((g) => ({ id: g.id, name: g.name, path: g.path, addedAt: Number(g.addedAt) || 0,
          repos: (Array.isArray(g.repos) ? g.repos : []).filter((d) => typeof d === 'string' && isAbsolute(d)) }));
    }
    linkDeps = c.linkNodeModules === true;
    if (Array.isArray(c.accounts)) gitAccounts = c.accounts.filter((a) => a && SERVICES[a.service] && HOST_RE.test(a.host || '') && USER_RE.test(a.username || ''));
    if (typeof c.cloneDir === 'string' && isAbsolute(c.cloneDir)) cloneDir = c.cloneDir;
  } catch {}
  gitReposP = null;
}

async function saveConf() {
  try {
    await mkdir(dirname(CONF_FILE), { recursive: true });
    await writeFile(CONF_FILE, JSON.stringify({ extra: gitExtra, groups: gitGroups, linkNodeModules: linkDeps, accounts: gitAccounts, cloneDir }, null, 2) + '\n');
  } catch (e) { console.error(`Could not write ${CONF_FILE}: ${e.message}`); }
}

// Seed the settings once from another tool's list (a host server moving its own repo list
// over). Does nothing when the settings file already exists.
export async function seedGitConf({ extra = [], groups = [], linkNodeModules = false } = {}) {
  if (existsSync(CONF_FILE)) return false;
  gitExtra = extra.filter((p) => typeof p === 'string' && isAbsolute(p));
  gitGroups = [];
  for (const g of groups) {
    const P = resolve(g.path);
    if (!existsSync(P) || gitGroups.some((x) => x.path === P)) continue;
    gitGroups.push({ id: 'p' + (Date.now() + gitGroups.length).toString(36), name: g.name || basename(P), path: P,
      repos: Array.isArray(g.repos) ? g.repos : (await scanRepos(P)).repos, addedAt: Date.now() });
  }
  linkDeps = !!linkNodeModules;
  await saveConf();
  gitReposP = null;
  return true;
}

function normPath(p) {
  let s = String(p ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
  if (s === '~' || s.startsWith('~/')) s = homedir() + s.slice(1);
  if (!s) throw new Error('Enter a path.');
  if (!isAbsolute(s)) throw new Error('Use an absolute path — start with / or ~/.');
  return resolve(s);
}

// Bọc đường dẫn cho lệnh shell in ra trang — đường dẫn có dấu cách, dấu nháy vẫn dán chạy được.
const q = (s) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// 'dir' | 'file' | 'broken' (symlink trỏ vào chỗ không còn) | 'missing'
async function kindOf(p) {
  try {
    const l = await lstat(p);
    if (!l.isSymbolicLink()) return l.isDirectory() ? 'dir' : 'file';
    try { return (await stat(p)).isDirectory() ? 'dir' : 'file'; } catch { return 'broken'; }
  } catch { return 'missing'; }
}

// Windows: FolderBrowserDialog qua PowerShell. Đường dẫn và lời nhắc đi qua biến môi trường,
// không ghép vào mã PowerShell. Form TopMost làm chủ để hộp không chìm sau cửa sổ app; stdout
// đặt UTF-8 để tên thư mục có dấu (tiếng Việt, CJK) không vỡ. Bấm Huỷ → không in gì.
const PICK_PS = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$d.Description = $env:MENORAH_PICK_PROMPT',
  '$d.SelectedPath = $env:MENORAH_PICK_FROM',
  '$d.ShowNewFolderButton = $true',
  '$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
  'if ($d.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
].join('; ');

function pickFolderWin(start, prompt) {
  return new Promise((done, fail) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', PICK_PS], {
      timeout: 5 * 60 * 1000, windowsHide: true,
      env: { ...process.env, MENORAH_PICK_FROM: start, MENORAH_PICK_PROMPT: prompt },
    }, (e, so, se) => {
      if (e) return fail(new Error(`Could not open the folder picker: ${(se || e.message).trim()}`));
      const path = so.trim();
      done(path ? { path } : { cancelled: true });
    });
  });
}

// Hộp chọn thư mục của hệ điều hành. macOS: đường dẫn mặc định đi qua argv, không ghép vào
// chuỗi AppleScript — khỏi lo dấu nháy trong tên thư mục.
export function pickFolder({ prompt = 'Choose a folder', from = homedir() } = {}) {
  const start = existsSync(from) ? from : homedir();
  if (process.platform === 'win32') return pickFolderWin(start, prompt);
  return new Promise((done, fail) => {
    if (process.platform !== 'darwin') return fail(new Error('The folder picker is not available on this system — paste the path instead.'));
    execFile('osascript', [
      '-e', 'on run argv',
      '-e', 'activate',
      '-e', 'return POSIX path of (choose folder with prompt (item 2 of argv) default location (POSIX file (item 1 of argv)))',
      '-e', 'end run',
      start, prompt,
    ], { timeout: 5 * 60 * 1000 }, (e, so, se) => {
      if (!e) return done({ path: so.trim().replace(/\/$/, '') });
      if (/-128/.test(se || '')) return done({ cancelled: true });   // bấm Huỷ
      fail(new Error(`Could not open the folder picker: ${(se || e.message).trim()}`));
    });
  });
}

function gitBranch(dir) {
  return new Promise((done) => {
    execFile('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 3000 }, (e, so) =>
      done(e ? null : so.trim()));
  });
}

// ─── Git ────────────────────────────────────────────────────────────────────
// Tab Git: xem trạng thái và chạy một nhóm lệnh git có chọn lọc trên các repo của dự
// án. Luật gitflow (CLAUDE.md) chặn ở ĐÂY chứ không chỉ ở trang:
//   • không bao giờ force push — không có đường nào ghép ra `--force` hay refspec `+`;
//   • không merge `develop` vào main/staging/prod; ở repo sản phẩm, các nhánh đó chỉ
//     nhận qua pull request nên trang cũng không merge vào, không push lên chúng;
//   • rebase chỉ khi mọi commit bị viết lại chưa lên remote nào — viết lại commit đã
//     push thì phải force push;
//   • merge/pull/rebase cần cây sạch (tệp đã theo dõi): `merge --abort` không dựng lại
//     được thay đổi dở có từ trước khi merge;
//   • commit không đi thẳng vào main/staging/prod của repo sản phẩm; không có amend, không
//     có discard (bỏ thay đổi) — hai việc đó mất dữ liệu nếu bấm nhầm;
//   • diff không hiện nội dung tệp bí mật (`SECRET_RE`) — chỉ báo tên tệp.
// Lệnh chạy bằng execFile với mảng tham số, không qua shell. Repo, worktree, nhánh,
// remote đều phải khớp danh sách server tự đọc — request không mang đường dẫn.
const PROTECTED_RE = /^(main|master|staging|prod|production)$/;
const SHARED_RE = /^(develop|main|master|staging|prod|production)$/;
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',            // hỏi mật khẩu thì thất bại ngay, không treo
  GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_PAGER: 'cat',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
};
// Lệnh nhận đường dẫn từ trang coi đường dẫn là tên tệp thật, không phải pattern:
// `:(glob)**/.env` không lọt qua bộ lọc tệp bí mật, `*` không stage nhầm cả loạt. Chỉ bật
// cho các lệnh này — `stash -u` hay hook commit (lint-staged) dùng pathspec nội bộ như `:/`,
// gặp chế độ literal là hỏng ngầm (stash xong tệp mới vẫn nằm nguyên).
const GIT_ENV_LITERAL = { ...GIT_ENV, GIT_LITERAL_PATHSPECS: '1' };
const PATH_CMDS = new Set(['add', 'restore', 'clean', 'diff', 'show']);
// Nhận diện theo tên tệp — chỉ là lưới thô, không thay được .gitignore. Mẫu `.env.example`
// (và sample/template/dist) là tệp mẫu để commit, không tính là bí mật.
const SECRET_RE = /(^|\/)(\.env(rc|\.[^/]*)?|\.npmrc|\.pgpass|\.netrc|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|tokens?\.json|\.docker\/config\.json|[^/]*(secret|credential)[^/]*)$|\.(pem|key|p8|p12|pfx|ppk|crt|cer|der|jks|keystore|kdbx|tfvars|tfvars\.json|tfstate|tfstate\.backup)$/i;
const SECRET_OK_RE = /(^|\/)\.env\.(example|sample|template|dist)$/i;
const isSecret = (p) => SECRET_RE.test(p) && !SECRET_OK_RE.test(p);
const SHA_RE = /^[0-9a-f]{7,40}$/;
const GIT_QUICK_OPS = new Set(['fetch', 'stage', 'unstage']);   // chạy ngay, không qua hộp xác nhận
const GIT_HISTORY_MAX = 40;
let gitHistory = [];          // { t, repo, wt, title, ok, steps: [{ cmd, code, out }] }
const gitBusy = new Set();    // thư mục repo đang chạy lệnh ghi
const gitRunning = new Map(); // thư mục repo → { cmd, step, of, phase, pct, line } của lệnh đang chạy

// `onErr` nhận stderr ngay khi git in ra (dòng tiến độ của --progress) — output đầy đủ vẫn trả ở cuối.
function git(cwd, args, timeout = 15000, onErr = null) {
  const env = PATH_CMDS.has(args[0]) ? GIT_ENV_LITERAL : GIT_ENV;
  return new Promise((done) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(guard); done(r); } };
    const child = execFile('git', ['-C', cwd, '-c', 'core.quotepath=false', '-c', 'color.ui=never', ...args],
      { timeout, killSignal: 'SIGKILL', env, maxBuffer: 8 * 1024 * 1024 }, (e, so, se) =>
        finish({ ok: !e, code: e ? (e.killed ? 'timeout' : typeof e.code === 'number' ? e.code : 1) : 0, out: so || '', err: se || '' }));
    if (onErr) child.stderr.on('data', (d) => onErr(String(d)));
    // Tiến trình cháu (ssh) có thể giữ pipe sau khi git bị giết — callback không về, khoá
    // repo kẹt tới khi khởi động lại server. Quá hạn 5s thì tự trả về.
    const guard = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, code: 'timeout', out: '', err: '' }); }, timeout + 5000);
  });
}
// URL remote dạng https://user:token@host lọt vào output của git — che trước khi lưu/hiện.
const hideCred = (t) => t.replace(/(\w+:\/\/)[^\s/@]+@/g, '$1***@');
const gitLines = async (cwd, args) => { const r = await git(cwd, args); return r.ok ? r.out.split('\n').filter(Boolean) : []; };

// Repo = repo của các nhóm project + repo người dùng tự thêm (lưu ở git.json).
let gitExtra = [];
let gitGroups = [];   // { id, name, path, repos: [thư mục repo], addedAt } — xem gitGroupOp
let gitReposP = null;

async function discoverRepos() {
  const cands = [];
  for (const g of gitGroups) for (const dir of g.repos) cands.push({ dir, label: basename(dir), group: g.id });
  for (const dir of gitExtra) cands.push({ dir, label: basename(dir), extra: true });

  const seen = new Set(), out = [];
  for (const c of cands) {
    if (!existsSync(join(c.dir, '.git'))) continue;
    let real;
    try { real = await realpath(c.dir); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    const origin = (await git(c.dir, ['config', '--get', 'remote.origin.url'], 3000)).out.trim();
    out.push({ ...c, real, origin, gitflow: await hasDevelop(c.dir) });
  }
  // Bản clone phụ trỏ cùng origin với repo chính: push từ đó dễ đè nhánh chung. Chỉ cho xem
  // và fetch. Bản chính = bản có tên thư mục trùng tên repo trên remote; không bản nào trùng
  // thì lấy bản đứng trước trong danh sách.
  const remoteName = (u) => u.replace(/\.git\/?$/, '').split(/[/:]/).pop();
  for (const r of out) {
    if (!r.origin) continue;
    const same = out.filter((o) => o.origin === r.origin);
    if (same.length < 2) continue;
    const main = same.find((o) => basename(o.dir) === remoteName(r.origin)) || same[0];
    if (main !== r) r.readOnly = `Secondary clone with the same origin as ${main.label} — view and fetch only; run write commands in ${main.label}.`;
  }
  const ids = new Map();
  for (const r of out) {
    const base = r.label.replace(/[^\w.-]/g, '-');
    const n = (ids.get(base) || 0) + 1;
    ids.set(base, n);
    r.id = n > 1 ? `${base}-${n}` : base;
  }
  return out;
}
// Repo theo gitflow (có nhánh develop ở máy hoặc trên remote): main/master/staging/prod chỉ
// nhận thay đổi qua pull request. Repo không có develop (trunk-based) commit thẳng được.
async function hasDevelop(dir) {
  return !!(await git(dir, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/heads/develop', 'refs/remotes/*/develop'], 3000)).out.trim();
}

function gitRepos(refresh) {
  if (refresh || !gitReposP) gitReposP = discoverRepos();
  return gitReposP;
}

async function worktreesOf(dir) {
  const list = [];
  let cur = null;
  for (const ln of await gitLines(dir, ['worktree', 'list', '--porcelain'])) {
    if (ln.startsWith('worktree ')) list.push(cur = { path: ln.slice(9), branch: null, detached: false });
    else if (cur && ln.startsWith('branch ')) cur.branch = ln.slice(7).replace(/^refs\/heads\//, '');
    else if (cur && ln === 'detached') cur.detached = true;
    else if (cur && ln.startsWith('prunable')) cur.prunable = true;
    else if (cur && ln.startsWith('locked')) cur.locked = true;
  }
  // Mục đầu là cây chính. Còn lại đặt tên theo đường dẫn tương đối (`.worktrees/<tên>`).
  const main = list.shift();
  const extra = list.filter((w) => !w.prunable).map((w) => ({ ...w, rel: relTo(main?.path || dir, w.path) }));
  // Lúc tạo = lúc `git worktree add` ghi tệp .git của worktree; cây chính = lúc clone (thư mục .git).
  // Không đọc được .git thì lấy lúc tạo thư mục worktree. FS không có birthtime thì lùi về ctime.
  await Promise.all([...(main ? [main] : []), ...extra].map(async (w) => {
    const sts = await Promise.all([join(w.path, '.git'), w.path].map((p) => stat(p).catch(() => null)));
    w.created = Math.round(sts.map((s) => s?.birthtimeMs).find((t) => t > 0) || sts.map((s) => s?.ctimeMs).find((t) => t > 0) || 0);
  }));
  return { main, extra };
}
function relTo(base, p) {
  return p.startsWith(base + '/') ? p.slice(base.length + 1) : p;
}

// Chọn repo + worktree từ request. `wt` là đường dẫn tương đối lấy từ `worktree list`.
async function gitTarget(body) {
  const r = (await gitRepos()).find((x) => x.id === body.repo);
  if (!r) throw new Error('Repository not found — click Refresh.');
  const wts = await worktreesOf(r.dir);
  // Đường dẫn thật (git in đường dẫn thật trong `worktree list`, `%(worktreepath)`).
  let dir = wts.main?.path || r.real;
  if (body.wt) {
    const w = wts.extra.find((x) => x.rel === body.wt);
    if (!w) throw new Error(`Worktree ${body.wt} not found.`);
    dir = w.path;
  }
  return { r, dir, wt: body.wt || '', wts };
}

// Phiên bản git (đọc một lần) — vài cờ chỉ có từ một bản nhất định, như `pull --no-rebase --autostash` (2.27).
let gitVer = null;
async function gitAtLeast(major, minor) {
  if (!gitVer) { const m = /(\d+)\.(\d+)/.exec((await git(homedir(), ['--version'], 5000)).out); gitVer = m ? [+m[1], +m[2]] : [0, 0]; }
  return gitVer[0] > major || (gitVer[0] === major && gitVer[1] >= minor);
}

// `untracked`: 'normal' gom thư mục mới thành một dòng (đủ cho danh sách repo); 'all' liệt
// kê từng tệp để stage và xem diff từng tệp.
async function gitStatus(dir, untracked = 'normal', cap = 300) {
  const st = await git(dir, ['status', '--porcelain=v2', '--branch', `--untracked-files=${untracked}`], 10000);
  if (!st.ok) return { error: hideCred((st.err || st.out).trim()) || 'git status failed' };
  const s = { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [], staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  for (const ln of st.out.split('\n')) {
    if (!ln) continue;
    if (ln.startsWith('# branch.head ')) { const h = ln.slice(14); s.detached = h === '(detached)'; s.branch = s.detached ? null : h; }
    else if (ln.startsWith('# branch.oid ')) s.oid = ln.slice(13);
    else if (ln.startsWith('# branch.upstream ')) s.upstream = ln.slice(18);
    else if (ln.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(ln); if (m) { s.ahead = +m[1]; s.behind = +m[2]; } }
    else if (ln[0] === '1' || ln[0] === '2') {
      const f = ln.split(' ');
      const xy = f[1];
      // Dạng 2 (đổi tên): "<đường dẫn>\t<đường dẫn cũ>" nằm sau 9 trường.
      const [path, orig] = f.slice(ln[0] === '1' ? 8 : 9).join(' ').split('\t');
      if (xy[0] !== '.') s.staged++;
      if (xy[1] !== '.') s.unstaged++;
      s.files.push(orig ? { xy, path, orig } : { xy, path });
    } else if (ln[0] === 'u') {
      s.conflicts++;
      s.files.push({ xy: 'UU', path: ln.split(' ').slice(10).join(' ') });
    } else if (ln[0] === '?') { s.untracked++; s.files.push({ xy: '??', path: ln.slice(2) }); }
  }
  s.tracked = s.staged + s.unstaged + s.conflicts;
  const gd = (await git(dir, ['rev-parse', '--absolute-git-dir'], 3000)).out.trim();
  s.op = !gd ? null
    : existsSync(join(gd, 'rebase-merge')) || existsSync(join(gd, 'rebase-apply')) ? 'rebase'
    : existsSync(join(gd, 'MERGE_HEAD')) ? 'merge'
    : existsSync(join(gd, 'CHERRY_PICK_HEAD')) ? 'cherry-pick'
    : existsSync(join(gd, 'REVERT_HEAD')) ? 'revert' : null;
  s.filesTotal = s.files.length;
  s.files = s.files.slice(0, cap);
  return s;
}

async function fetchedAt(dir) {
  const common = (await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 3000)).out.trim();
  // fetch hỏng git vẫn ghi lại FETCH_HEAD rỗng — không tính là đã fetch
  try { const st = await stat(join(common, 'FETCH_HEAD')); return st.size ? st.mtimeMs : null; } catch { return null; }
}

async function gitList(refresh) {
  const repos = await gitRepos(refresh);
  return Promise.all(repos.map(async (r) => {
    const [s, wts, fetched] = await Promise.all([gitStatus(r.dir), worktreesOf(r.dir), fetchedAt(r.dir)]);
    return {
      id: r.id, label: r.label, dir: r.dir, real: r.real, gitflow: r.gitflow, readOnly: r.readOnly || null, extra: !!r.extra, group: r.group || null,
      status: s, fetchedAt: fetched,
      worktrees: wts.extra.map((w) => ({ rel: w.rel, branch: w.branch, detached: w.detached })),
    };
  }));
}

async function gitRemotes(dir) {
  return [...new Set((await gitLines(dir, ['remote'])))];
}

async function gitBranches(dir) {
  const local = (await gitLines(dir, ['for-each-ref', 'refs/heads', '--sort=-committerdate',
    '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:unix)%09%(worktreepath)']))
    .map((ln) => { const [name, upstream, track, when, wtPath] = ln.split('\t'); return { name, upstream, track, when, wtPath }; });
  const remote = (await gitLines(dir, ['for-each-ref', 'refs/remotes', '--sort=-committerdate', '--count=400',
    '--format=%(refname:short)%09%(committerdate:unix)%09%(symref)']))
    .map((ln) => { const [name, when, sym] = ln.split('\t'); return { name, when, sym }; })
    .filter((b) => !b.sym && !b.name.endsWith('/HEAD') && b.name.includes('/'));
  return { local, remote, remotes: await gitRemotes(dir) };
}

async function gitSubmodules(dir) {
  if (!existsSync(join(dir, '.gitmodules'))) return [];
  const state = { ' ': 'ok', '+': 'moved', '-': 'uninit', U: 'conflict' };
  return (await gitLines(dir, ['submodule', 'status'])).map((ln) => {
    const m = /^([ +\-U])([0-9a-f]+) (\S+)(?: \((.*)\))?$/.exec(ln);
    return m && { state: state[m[1]], sha: m[2].slice(0, 8), path: m[3], desc: m[4] || '' };
  }).filter(Boolean);
}

async function gitDetail(body) {
  const { r, dir, wt, wts } = await gitTarget(body);
  const [status, br, stash, subs, fetched, identity, wtStat] = await Promise.all([
    gitStatus(dir, 'all', 1000), gitBranches(dir),
    gitLines(dir, ['stash', 'list', '--format=%H%x09%gd%x09%ct%x09%gs']),
    gitSubmodules(dir), fetchedAt(dir),
    gitIdentity(dir),
    // ↑↓ của từng worktree cho thanh trái — bỏ tệp mới để đọc nhanh.
    Promise.all(wts.extra.map((w) => gitStatus(w.path, 'no', 0))),
  ]);
  // Đánh dấu tệp bí mật chưa theo dõi để trang ẩn nút Stage (server vẫn chặn ở op stage).
  for (const f of status.files || []) if (f.xy === '??' && isSecret(f.path)) f.secret = true;
  return {
    id: r.id, label: r.label, dir, wt, gitflow: r.gitflow, readOnly: r.readOnly || null, mainPath: wts.main?.path || r.real, mainCreated: wts.main?.created || 0,
    worktrees: wts.extra.map((w, i) => {
      const x = wtStat[i];
      return { rel: w.rel, path: w.path, branch: w.branch, created: w.created, ahead: x.ahead || 0, behind: x.behind || 0, upstream: x.upstream || null, tracked: x.tracked || 0 };
    }),
    status, branches: br, remotes: br.remotes, fetchedAt: fetched, submodules: subs,
    stash: stash.map((ln) => { const [hash, ref, when, ...m] = ln.split('\t'); return { hash, ref, when, subject: m.join('\t') }; }),
    identity,
    canPush: !r.readOnly, protectedBranch: r.gitflow && PROTECTED_RE.test(status.branch || ''),
  };
}

// Đồ thị commit: mọi nhánh cục bộ, nhánh remote, tag và HEAD — không lấy refs/stash (commit
// stash có hai cha lạ, vẽ ra chỉ rối). Trang tự xếp làn.
async function gitGraph(body) {
  const { dir } = await gitTarget(body);
  const n = Math.min(Math.max(Number(body.n) || 300, body.head === '1' ? 10 : 50), 3000);
  // head=1: chỉ lịch sử của HEAD (dòng thời gian tab Review), không lấy nhánh khác.
  const refs = body.head === '1' ? ['HEAD'] : ['--branches', '--remotes', '--tags', 'HEAD'];
  const r = await git(dir, ['log', ...refs, '--date-order', '-n', String(n + 1),
    '--format=%H%x1f%P%x1f%an%x1f%ct%x1f%D%x1f%s%x1e'], 30000);
  if (!r.ok) return { commits: [], more: false, error: /does not have any commits|unknown revision/.test(r.err) ? null : hideCred(r.err.trim()) };
  const commits = r.out.split('\x1e').map((x) => x.replace(/^\n/, '')).filter(Boolean).map((x) => {
    const [h, p, a, t, refs, ...m] = x.split('\x1f');
    return { h, p: p ? p.split(' ') : [], a, t: +t, refs, s: m.join('\x1f') };
  });
  return { commits: commits.slice(0, n), more: commits.length > n };
}

// Tệp đổi trong một commit, so với cha thứ nhất (merge commit cũng vậy — giống GitKraken).
async function commitFiles(dir, sha) {
  const r = await git(dir, ['diff-tree', '-r', '-M', '--root', '--no-commit-id', '--name-status', '-m', '--first-parent', '-z', sha], 15000);
  if (!r.ok) return [];
  const tok = r.out.split('\0'), files = [];
  for (let i = 0; i < tok.length && files.length < 2000;) {
    const st = tok[i++];
    if (!st) continue;
    if (st[0] === 'R' || st[0] === 'C') files.push({ st: st[0], from: tok[i++], path: tok[i++] });
    else files.push({ st: st[0], path: tok[i++] });
  }
  return files;
}

async function gitCommitInfo(body) {
  const { dir } = await gitTarget(body);
  if (!SHA_RE.test(body.sha || '')) throw new Error('Invalid SHA.');
  const [show, files] = await Promise.all([
    git(dir, ['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%at%x1f%cn%x1f%ct%x1f%B', body.sha, '--']),
    commitFiles(dir, body.sha),
  ]);
  if (!show.ok) throw new Error('Commit not found.');
  const [h, p, an, at, cn, ct, ...b] = show.out.split('\x1f');
  const msg = b.join('\x1f').trim();
  const nl = msg.indexOf('\n');
  return {
    sha: h, parents: p ? p.split(' ') : [], author: an, when: +at, committer: cn, committed: +ct,
    subject: nl < 0 ? msg : msg.slice(0, nl), body: nl < 0 ? '' : msg.slice(nl + 1).trim(), files,
  };
}

// Diff một tệp: thay đổi đang làm (`staged` hay chưa) hoặc trong một commit. Tên tệp phải
// nằm trong danh sách server tự đọc, nên không xin được diff cả thư mục chứa `.env`.
const DIFF_MAX = 400 * 1024;
async function gitDiff(body) {
  const { dir } = await gitTarget(body);
  const path = String(body.path || '');
  let args, from = null;
  if (body.sha) {
    if (!SHA_RE.test(body.sha)) throw new Error('Invalid SHA.');
    const f = (await commitFiles(dir, body.sha)).find((x) => x.path === path);
    if (!f) throw new Error('This commit does not contain that file.');
    from = f.from || null;
    if (!isSecret(path) && !(from && isSecret(from))) {
      const parent = (await git(dir, ['rev-parse', '-q', '--verify', `${body.sha}^1`], 3000)).out.trim();
      const paths = from ? [from, path] : [path];
      args = parent ? ['diff', '-M', parent, body.sha, '--', ...paths] : ['show', '--format=', body.sha, '--', ...paths];
    }
  } else {
    const f = (await gitStatus(dir, 'all', Infinity)).files.find((x) => x.path === path);
    if (!f) throw new Error('The file no longer has changes — click Refresh.');
    from = f.orig || null;
    if (!isSecret(path) && !(from && isSecret(from))) {
      args = f.xy === '??' ? ['diff', '--no-index', '--', '/dev/null', path]
        : body.staged ? ['diff', '--cached', '-M', '--', ...(from ? [from, path] : [path])]
        : ['diff', '--', path];
    }
  }
  if (!args) return { path, from, secret: true, text: '', cut: false };
  const r = await git(dir, args, 15000);
  // `diff --no-index` trả mã 1 khi hai bên khác nhau — vẫn là kết quả đúng.
  if (!r.ok && !(r.code === 1 && r.out)) throw new Error((r.err || 'git diff failed').trim());
  let text = r.out, cut = false;
  if (text.length > DIFF_MAX) { text = text.slice(0, text.lastIndexOf('\n', DIFF_MAX)); cut = true; }
  return { path, from, secret: false, text, cut };
}

// ─── Chế độ Files: cây tệp, nội dung tệp, lịch sử một tệp ───
// Cây = tệp git theo dõi + tệp mới chưa bị .gitignore (node_modules, dist không vào).
const TREE_MAX = 30000;
async function gitFiles(body) {
  const { dir } = await gitTarget(body);
  const [ls, st] = await Promise.all([
    git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], 20000),
    gitStatus(dir, 'all', 5000),
  ]);
  if (!ls.ok) throw new Error(hideCred(ls.err.trim()) || 'git ls-files failed');
  // --cached liệt kê một tệp xung đột ba lần (stage 1–3).
  const all = [...new Set(ls.out.split('\0').filter(Boolean))];
  // xy như `git status --porcelain`: trang tô màu tệp và chọn diff staged hay chưa.
  const xy = {};
  for (const f of st.files || []) xy[f.path] = f.xy;
  return { files: all.slice(0, TREE_MAX), cut: all.length > TREE_MAX, xy };
}

// Nội dung tệp trên đĩa, cùng luật với /git-view: không ra khỏi repo, không vào .git, không đọc tệp bí mật.
const FILE_MAX = 2 * 1024 * 1024;
async function gitFile(body) {
  const { dir } = await gitTarget(body);
  const path = String(body.path || '');
  const parts = path.split('/');
  if (!path || parts.some((x) => !x || x === '.' || x === '..' || x === '.git' || x.includes('\0') || x.includes('\\'))) throw new Error('Invalid path.');
  if (isSecret(path)) return { path, secret: true };
  const root = await realpath(dir);
  const real = await realpath(join(root, path)).catch(() => null);
  const rel = real && real.startsWith(root + sep) ? real.slice(root.length + 1) : null;
  if (!rel) return { path, missing: true };
  if (rel.split(sep).includes('.git') || isSecret(rel)) return { path, secret: true };
  const st = await stat(real);
  if (!st.isFile()) return { path, missing: true };
  const fh = await open(real, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, FILE_MAX));
    await fh.read(buf, 0, buf.length, 0);
    if (buf.subarray(0, 8000).includes(0)) return { path, size: st.size, binary: true };
    const cut = st.size > FILE_MAX;
    return { path, size: st.size, text: buf.toString('utf8'), cut, hash: cut ? null : sha(buf) };
  } finally { await fh.close(); }
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// Lưu một tệp đang có từ trình soạn của IDE. base = hash lúc đọc: tệp trên đĩa đã đổi từ đó (agent vừa
// sửa) thì không ghi, trả conflict cùng nội dung mới — trừ khi force. Chỉ tệp văn bản thường trong
// worktree; tệp bí mật, .git, symlink ra ngoài, clone phụ (readOnly) bị chặn như khi đọc.
async function gitSave(body) {
  const { r, dir } = await gitTarget(body);
  if (r.readOnly) throw new Error(r.readOnly);
  const path = String(body.path || ''), text = body.text;
  if (typeof text !== 'string') throw new Error('Nothing to save.');
  const parts = path.split('/');
  if (!path || parts.some((x) => !x || x === '.' || x === '..' || x === '.git' || x.includes('\0') || x.includes('\\'))) throw new Error('Invalid path.');
  if (isSecret(path)) throw new Error('Secret files cannot be edited here.');
  const out = Buffer.from(text, 'utf8');
  if (out.length > FILE_MAX) throw new Error('The file is too large to save here (over 2 MB).');
  const root = await realpath(dir);
  const real = await realpath(join(root, path)).catch(() => null);
  const rel = real && real.startsWith(root + sep) ? real.slice(root.length + 1) : null;
  if (!rel) throw new Error(`${path} no longer exists.`);
  if (rel.split(sep).includes('.git') || isSecret(rel)) throw new Error('Secret files cannot be edited here.');
  const st = await stat(real);
  if (!st.isFile()) throw new Error(`${path} is not a file.`);
  if (st.size > FILE_MAX) throw new Error('The file is too large to edit here (over 2 MB).');
  const cur = await readFile(real);
  if (cur.subarray(0, 8000).includes(0)) throw new Error('Binary files cannot be edited here.');
  const hash = sha(cur);
  if (!body.force && body.base !== hash) return { conflict: true, text: cur.toString('utf8'), hash };
  if (hash !== sha(out)) await writeFile(real, out);
  return { ok: true, hash: sha(out), size: out.length };
}

// Các commit chạm vào một tệp, theo cả tên cũ khi đổi tên (--follow). `path` ở mỗi dòng là tên
// tệp trong commit đó, để /api/git/diff lấy đúng diff.
async function gitFileLog(body) {
  const { dir } = await gitTarget(body);
  const path = String(body.path || '');
  if (!path || path.startsWith('-') || path.includes('\0')) throw new Error('Invalid path.');
  const n = Math.min(Math.max(Number(body.n) || 100, 10), 1000);
  const r = await git(dir, ['log', '--follow', '-M', '-n', String(n + 1), '--name-status',
    '--format=%x1e%H%x1f%an%x1f%at%x1f%s', '--', ':(literal)' + path], 20000);
  if (!r.ok) return { commits: [], more: false, error: /does not have any commits/.test(r.err) ? null : hideCred(r.err.trim()) };
  const commits = [];
  for (const rec of r.out.split('\x1e')) {
    const nl = rec.indexOf('\n');
    if (!rec.trim()) continue;
    const [h, a, t, s] = (nl < 0 ? rec : rec.slice(0, nl)).split('\x1f');
    // Dòng name-status: "M\tpath" hay "R087\tcũ\tmới". Commit merge không có dòng nào → bỏ.
    const ln = (nl < 0 ? '' : rec.slice(nl + 1)).split('\n').find((x) => /^[A-Z]\d*\t/.test(x));
    if (!ln) continue;
    const f = ln.split('\t');
    commits.push({ h, a, t: +t, s, st: f[0][0], path: f[f.length - 1], from: f.length > 2 ? f[1] : null });
  }
  return { commits: commits.slice(0, n), more: commits.length > n };
}

// Nhánh nguồn/đích cho merge, rebase, switch, tạo nhánh: phải là tên đang có.
function pickRef(br, name) {
  if (typeof name !== 'string' || !name || name.startsWith('-')) throw new Error('No branch selected.');
  const l = br.local.find((b) => b.name === name);
  if (l) return { name, short: name, remote: null, local: true };
  const rm = br.remote.find((b) => b.name === name);
  if (rm) {
    // Tách theo danh sách remote thật: remote có thể tên "a/b".
    const remote = splitRemote(br.remotes, name);
    const short = remote ? name.slice(remote.length + 1) : '';
    if (!short || short.startsWith('-')) throw new Error(`Branch name ${name} cannot be used here.`);
    return { name, short, remote, local: false };
  }
  throw new Error(`Branch ${name} not found — fetch and try again.`);
}

function splitRemote(remotes, name) {
  return [...remotes].sort((a, b) => b.length - a.length).find((x) => name.startsWith(x + '/')) || null;
}

async function countRev(dir, args) {
  const r = await git(dir, ['rev-list', '--count', ...args]);
  return r.ok ? Number(r.out.trim()) : null;
}

// Commit trong `range` đã nằm trên remote nào đó chưa. Viết lại chúng thì phải force push.
async function pushedInRange(dir, range) {
  const all = await countRev(dir, [range]);
  const local = await countRev(dir, [range, '--not', '--remotes']);
  return { all, pushed: all == null || local == null ? null : all - local };
}

// Message commit từ trang: summary một dòng ≤ 200 ký tự, description ≤ 8000.
function commitMessage(body) {
  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
  const desc = typeof body.description === 'string' ? body.description.trim() : '';
  if (!summary) return { err: 'Enter a commit summary.' };
  if (/\n/.test(summary) || summary.length > 200) return { err: 'The summary must be one line, at most 200 characters.' };
  if (desc.length > 8000) return { err: 'The description is longer than 8000 characters.' };
  return { args: ['commit', '-m', summary, ...(desc ? ['-m', desc] : [])] };
}
// Tên + email ghi vào commit. Một lệnh đọc mọi tầng (global, local…): giá trị cuối cùng là giá trị
// git dùng; `local` = repo có cấu hình riêng (đè global), `global` để hộp sửa điền sẵn.
async function gitIdentity(dir) {
  const r = await git(dir, ['config', '--show-scope', '--get-regexp', '^user\\.(name|email)$'], 3000);
  const id = { name: '', email: '', local: false, global: { name: '', email: '' } };
  // git < 2.26 không có --show-scope (exit 129; exit 1 = chưa đặt gì): chỉ đọc giá trị đang dùng.
  if (!r.ok && r.code !== 1) {
    const [n, e] = await Promise.all(['user.name', 'user.email'].map((k) => git(dir, ['config', k], 3000)));
    return { ...id, name: n.out.trim(), email: e.out.trim() };
  }
  for (const ln of r.out.split('\n')) {
    const m = /^(\w+)\tuser\.(name|email)(?: (.*))?$/.exec(ln);
    if (!m) continue;
    const v = (m[3] || '').trim();
    id[m[2]] = v;
    if (m[1] === 'global') id.global[m[2]] = v;
    if (m[1] === 'local' || m[1] === 'worktree') id.local = true;
  }
  return id;
}
async function commitAuthor(dir) {
  const { name, email } = await gitIdentity(dir);
  if (!email) return { err: 'Your email for commits is not set — set it with Change… under the Commit box, then commit.' };
  return { text: `${name || '(user.name not set)'} <${email}>` };
}
// Hộp "Name & email": scope "repo" ghi vào .git/config của repo (mọi worktree dùng chung);
// "global" ghi ~/.gitconfig và bỏ cấu hình riêng của repo này để nó dùng luôn giá trị mới.
async function gitSetIdentity(body) {
  const { dir } = await gitTarget(body);
  const name = String(body.name || '').trim(), email = String(body.email || '').trim();
  if (!name || name.length > 100 || /[\0-\x1f<>]/.test(name)) throw new Error('Enter your name — up to 100 characters, no < or >.');
  if (!EMAIL_RE.test(email) || email.length > 200 || /[<>]/.test(email)) throw new Error('Enter a valid email, e.g. you@example.com.');
  const scope = body.scope === 'global' ? 'global' : 'local';
  for (const [k, v] of [['user.name', name], ['user.email', email]]) {
    const r = await git(dir, ['config', `--${scope}`, k, v], 5000);
    if (!r.ok) throw new Error(`git config ${k} failed: ${(r.err || r.out).trim() || r.code}`);
  }
  // Exit 5 = repo không có khoá đó — không phải lỗi.
  if (scope === 'global') for (const k of ['user.name', 'user.email']) await git(dir, ['config', '--local', '--unset-all', k], 5000);
  return gitIdentity(dir);
}
const wtShortName = (rel) => rel.replace(/^\.worktrees\//, '');

// Nút Generate ở khung Commit: viết summary + description từ diff đã stage bằng `claude -p` của
// máy (tài khoản Claude đã đăng nhập, không cần API key). Tắt mọi tool, MCP, CLAUDE.md, hook
// (--safe-mode), chạy ở thư mục tạm: model chỉ thấy đúng phần gửi vào. Tệp bí mật chỉ gửi tên.
// App mở từ Finder không có ~/.local/bin trong PATH — dò sẵn vài chỗ cài thường gặp.
const SUGGEST_MODEL = process.env.RUN_COMMIT_MODEL || 'claude-sonnet-5-5';
const SUGGEST_DIFF_MAX = 120 * 1024;
const SUGGEST_FILES_MAX = 300;
const SUGGEST_SCHEMA = JSON.stringify({
  type: 'object', additionalProperties: false, required: ['summary', 'description'],
  properties: { summary: { type: 'string' }, description: { type: 'string' } },
});
const SUGGEST_PROMPT = `You write git commit messages from a staged diff.
Follow this repository's convention as shown by its recent commit subjects: the language (if they are Vietnamese, write natural Vietnamese with full diacritics, keeping technical terms like commit, merge, API in English) and the "type(scope): ..." prefix if they use one.
summary: one line, at most 72 characters, no trailing period, says what the change does for the user or the code.
description: why the change was needed and what it does, plain prose wrapped near 72 characters, 2-6 lines; an empty string when the change is trivial. Do not list every file, do not add Co-Authored-By lines or emoji.
Describe only what the diff supports. When the author's draft is given, keep its intent and wording where the diff agrees with it.`;
const suggestBusy = new Set();
const claudeBin = () => process.env.CLAUDE_BIN
  || [join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find((p) => existsSync(p))
  || 'claude';

function claudePrint(input, timeout = 120000) {
  return new Promise((done) => {
    const child = spawn(claudeBin(), ['-p', '--safe-mode', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
      '--model', SUGGEST_MODEL, '--output-format', 'json', '--json-schema', SUGGEST_SCHEMA, '--system-prompt', SUGGEST_PROMPT],
    { cwd: tmpdir(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const guard = setTimeout(() => { child.kill('SIGKILL'); done({ err: 'Claude took longer than 2 minutes — try again.' }); }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(guard); done({ err: e.code === 'ENOENT' ? 'Claude Code CLI not found — install it or set CLAUDE_BIN.' : e.message }); });
    child.on('close', () => {
      clearTimeout(guard);
      let j = null;
      try { j = JSON.parse(out); } catch {}
      if (j && !j.is_error && j.structured_output) return done({ msg: j.structured_output });
      done({ err: (j?.result || err || out || 'Claude returned nothing.').trim().slice(0, 400) });
    });
    child.stdin.on('error', () => {});   // không spawn được thì ghi stdin báo EPIPE — lỗi đã trả ở 'error'
    child.stdin.end(input);
  });
}

async function gitSuggestMessage(body) {
  const { dir } = await gitTarget(body);
  if (suggestBusy.has(dir)) throw new Error('Already writing a message for this repository.');
  suggestBusy.add(dir);
  try {
    const s = await gitStatus(dir, 'all', Infinity);
    const staged = s.files.filter((f) => f.xy !== '??' && f.xy[0] !== '.');
    if (!staged.length) throw new Error('Nothing staged — stage files first.');
    const hidden = (f) => isSecret(f.path) || (f.orig && isSecret(f.orig));
    const paths = staged.filter((f) => !hidden(f)).slice(0, SUGGEST_FILES_MAX).flatMap((f) => (f.orig ? [f.orig, f.path] : [f.path]));
    const [stat, diff, log] = await Promise.all([
      git(dir, ['diff', '--cached', '-M', '--stat=120', '--stat-count=200'], 15000),
      paths.length ? git(dir, ['diff', '--cached', '-M', '--', ...paths], 20000) : { ok: true, out: '' },
      git(dir, ['log', '-n', '20', '--no-merges', '--format=%s'], 5000),
    ]);
    if (!diff.ok) throw new Error((diff.err || 'git diff failed').trim());
    let text = diff.out;
    if (text.length > SUGGEST_DIFF_MAX) text = text.slice(0, text.lastIndexOf('\n', SUGGEST_DIFF_MAX)) + '\n[diff truncated]';
    const draft = [body.summary, body.desc].map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).join('\n\n');
    const secret = staged.filter(hidden).map((f) => f.path);
    const input = [
      `Branch: ${s.branch || '(detached HEAD)'}`,
      `Recent commit subjects:\n${log.out.trim() || '(none)'}`,
      draft && `Author's draft:\n${draft.slice(0, 2000)}`,
      secret.length && `Secret files (content not shown): ${secret.join(', ')}`,
      `Staged files:\n${stat.out.trim()}`,
      `Staged diff:\n${text}`,
    ].filter(Boolean).join('\n\n');
    const r = await claudePrint(input);
    if (r.err) throw new Error(r.err);
    const summary = String(r.msg.summary || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!summary) throw new Error('Claude returned an empty summary — try again.');
    return { summary, description: String(r.msg.description || '').trim().slice(0, 8000), cut: text !== diff.out };
  } finally { suggestBusy.delete(dir); }
}

// Tiến trình đang đứng trong thư mục `dir` (cwd) — stack dev chạy từ worktree, terminal đã cd vào.
async function procsIn(dir) {
  const out = await sh('lsof', ['-nP', '-a', '-d', 'cwd', '-Fpcn']);
  if (out == null) return null;
  const hits = [];
  let pid = 0, command = '';
  for (const ln of (out || '').split('\n')) {
    if (ln[0] === 'p') pid = Number(ln.slice(1));
    else if (ln[0] === 'c') command = ln.slice(1);
    else if (ln[0] === 'n' && (ln.slice(1) === dir || ln.slice(1).startsWith(dir + '/')) && pid !== process.pid) hits.push({ pid, command });
  }
  return hits;
}
const SHELL_RE = /^-?(zsh|bash|sh|fish|login)$/;

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}`;
}

// Lập kế hoạch cho một thao tác: các bước lệnh, cảnh báo, hay lý do chặn. Trang gọi với
// `dryRun` để hiện đúng lệnh sẽ chạy trước khi PO bấm xác nhận; lúc chạy thật lập lại từ
// đầu nên trạng thái đổi giữa hai lần bấm vẫn bị soát.
async function gitPlan(body) {
  const t = await gitTarget(body);
  const { r, dir } = t;
  const op = body.op;
  const s = await gitStatus(dir, ['stage', 'unstage', 'discard', 'ship'].includes(op) ? 'all' : 'normal', Infinity);
  if (s.error) throw new Error(s.error);
  // `expect` = nhánh + commit HEAD lúc lập kế hoạch. Chạy thật mà khác thì dừng.
  const plan = { title: '', steps: [], warn: [], block: null, after: null, expect: `${s.branch || '(detached)'}@${s.oid || ''}`, branch: s.branch };
  const block = (msg) => { plan.block = msg; return plan; };
  const write = op !== 'fetch';
  if (write && r.readOnly) return block(r.readOnly);
  // Đang merge/rebase dở vẫn stage được: đó là cách đánh dấu đã sửa xong xung đột.
  // Bỏ thay đổi cũng được: tệp xung đột bị loại khỏi discard, tệp khác không dính tới merge.
  if (write && !['abort', 'continue', 'stage', 'unstage', 'discard'].includes(op) && s.op) {
    return block(`A ${s.op} is in progress — Continue or Abort it first.`);
  }
  const needClean = (what) => s.tracked ? block(`${s.tracked} tracked file(s) have uncommitted changes — commit or stash before you ${what}. "merge --abort" cannot restore changes that were there before.`) : null;
  const br = ['merge', 'rebase', 'switch', 'create', 'pull', 'push', 'delete-branch', 'delete-remote'].includes(op) ? await gitBranches(dir) : null;
  // Commit làm trên HEAD tách rời mà chưa nhánh nào giữ: rời đi (switch / checkout) là chỉ còn tìm lại qua reflog.
  const warnLeaveDetached = async () => {
    if (!s.detached) return;
    const lost = Number((await git(dir, ['rev-list', '--count', 'HEAD', '--not', '--branches', '--remotes', '--tags'], 5000)).out.trim()) || 0;
    if (lost) plan.warn.push(`${lost} commit(s) on the current detached HEAD are on no branch — after leaving, only the reflog finds them. To keep them, cancel and use New branch… first (or later: git branch <name> ${s.oid.slice(0, 8)}).`);
  };

  if (op === 'fetch') {
    plan.title = 'Fetch';
    plan.steps.push({ args: ['fetch', '--all', '--prune', '--no-recurse-submodules'], timeout: 120000 });
    return plan;
  }

  if (op === 'pull') {
    if (!s.branch) return block('Detached HEAD — switch to a branch first.');
    if (!s.upstream) return block(`Branch ${s.branch} has no upstream — push with -u first, or switch branches.`);
    const mode = ['ff', 'merge', 'rebase'].includes(body.mode) ? body.mode : 'ff';
    const ur = splitRemote(br.remotes, s.upstream);
    const upShort = ur ? s.upstream.slice(ur.length + 1) : s.upstream;
    if (upShort === 'develop' && PROTECTED_RE.test(s.branch)) return block(`${s.branch} tracks ${s.upstream} — pulling would merge develop into ${s.branch}, which gitflow forbids. Fix the upstream with git branch -u.`);
    if (mode !== 'ff' && r.gitflow && PROTECTED_RE.test(s.branch)) return block(`${s.branch} only accepts changes through a pull request — fast-forward pull only.`);
    plan.title = `Pull ${s.upstream}`;
    const mergeOk = !(r.gitflow && PROTECTED_RE.test(s.branch));
    // Rebase chỉ khi mọi commit sẽ bị viết lại còn nằm riêng ở máy này. Trả lý do chặn, hay null.
    const rebaseBlock = async () => {
      // Nhánh dùng chung hay chứa merge commit của nhánh feature — rebase làm phẳng mất chúng.
      if (SHARED_RE.test(s.branch)) return `${s.branch} is a shared branch — pull with merge or fast-forward, never rebase.`;
      if (!mergeOk) return `${s.branch} only accepts changes through a pull request — fast-forward pull only.`;
      const p = await pushedInRange(dir, `${s.upstream}..HEAD`);
      if (p.pushed == null) return 'Could not count commits already on the remote (git failed or timed out) — not rebasing without being sure.';
      if (p.pushed) return `${p.pushed} commit(s) that would be rewritten are already on the remote — rebasing would need a force push, which this project forbids. Pull with merge instead.`;
      return null;
    };
    // Thay đổi chưa commit: --autostash cất đi trước khi pull và trả lại sau (merge/rebase
    // --abort hay Continue cũng trả lại). Pull merge cần git 2.27+; git cũ hơn thì vẫn bắt commit/stash.
    const stash = async (what) => {
      if (!s.tracked) return [];
      if (what === 'pull' && !(await gitAtLeast(2, 27))) return needClean(what) ? null : [];
      plan.warn.push(`${s.tracked} file(s) with uncommitted changes are stashed before the pull and put back after (--autostash). If they clash with the pulled changes, git leaves conflict markers and keeps them in the stash list.`);
      return ['--autostash'];
    };
    if (mode === 'ff') {
      plan.steps.push({ args: ['pull', '--ff-only', '--no-recurse-submodules'], timeout: 120000 });
      if (s.ahead && s.behind) {
        // Đã rẽ nhánh: fast-forward chắc chắn hỏng — hộp xác nhận đưa luôn cách pull chạy được.
        if (!(await rebaseBlock())) plan.alt = { mode: 'rebase', label: 'Pull with rebase', why: `Your ${s.ahead} local commit(s) are not on the remote yet — rebase puts them on top of ${s.upstream}, with no merge commit.` };
        else if (mergeOk) plan.alt = { mode: 'merge', label: 'Pull with merge', why: `Merge ${s.upstream} into ${s.branch} with a merge commit.` };
        plan.warn.push(`The branch has diverged (↑${s.ahead} ↓${s.behind}) — fast-forward will fail${plan.alt ? '' : '; commit history has to be reconciled outside this page'}.`);
      }
    } else if (mode === 'merge') {
      const a = await stash('pull');
      if (!a) return plan;
      plan.steps.push({ args: ['pull', '--no-rebase', '--no-edit', ...a, '--no-recurse-submodules'], timeout: 120000 });
    } else {
      const why = await rebaseBlock();
      if (why) return block(why);
      const a = await stash('pull --rebase');
      plan.steps.push({ args: ['pull', '--rebase', ...a, '--no-recurse-submodules'], timeout: 120000 });
    }
    return plan;
  }

  if (op === 'push') {
    // `branch`: đẩy một nhánh cục bộ khác (menu chuột phải ở danh sách nhánh) — không cần switch.
    const other = body.branch && body.branch !== s.branch ? br.local.find((b) => b.name === body.branch) : null;
    if (body.branch && body.branch !== s.branch && !other) throw new Error(`Branch ${body.branch} not found — refresh and try again.`);
    const head = other ? other.name : s.branch;
    if (!head) return block('Detached HEAD — no branch to push.');
    const upstream = other ? other.upstream || null : s.upstream;
    const gone = other ? other.track === '[gone]' : false;
    const ahead = other ? Number(/ahead (\d+)/.exec(other.track)?.[1] || 0) : s.ahead;
    const behind = other ? Number(/behind (\d+)/.exec(other.track)?.[1] || 0) : s.behind;
    const remotes = await gitRemotes(dir);
    let remote, dest, setUp = false;
    if (upstream) {
      remote = splitRemote(remotes, upstream);
      if (!remote) return block(`Could not get the remote from upstream ${upstream}.`);
      dest = upstream.slice(remote.length + 1);
    } else {
      remote = body.remote || (remotes.includes('origin') ? 'origin' : remotes[0]);
      dest = head; setUp = true;
    }
    if (!remotes.includes(remote)) return block(`Remote ${remote} does not exist.`);
    if (r.gitflow && PROTECTED_RE.test(dest)) return block(`${dest} only accepts changes through a pull request — push a feature branch and open one.`);
    if (behind) plan.warn.push(`The remote has ${behind} commit(s) you don't have — the push will be rejected. Pull first.`);
    if (gone) plan.warn.push(`${upstream} was deleted on the remote — this push creates it again.`);
    else if (!setUp && !ahead) plan.warn.push('No new commits to push.');
    if (dest === 'develop') plan.warn.push('Pushing develop: Jenkins dev will build this version.');
    plan.title = `Push ${head} → ${remote}/${dest}`;
    plan.steps.push({ args: ['push', ...(setUp ? ['-u'] : []), remote, `${other ? `refs/heads/${head}` : 'HEAD'}:refs/heads/${dest}`], timeout: 120000, progress: true });
    if (other) plan.expect += '#' + head;
    return plan;
  }

  if (op === 'switch') {
    const ref = pickRef(br, body.branch);
    if (ref.local && ref.name === s.branch) return block(`Already on ${s.branch}.`);
    if (ref.local) {
      const holder = br.local.find((b) => b.name === ref.name)?.wtPath;
      if (holder && holder !== dir) return block(`${ref.name} is checked out in worktree ${relTo(r.real, holder)} — pick that worktree in the list.`);
      plan.steps.push({ args: ['switch', ref.name] });
    } else {
      if (br.local.some((b) => b.name === ref.short)) return block(`Local branch ${ref.short} already exists — pick it instead of ${ref.name}.`);
      plan.steps.push({ args: ['switch', '--track', ref.name] });
    }
    if (s.tracked) plan.warn.push(`${s.tracked} uncommitted file(s) will carry over to the new branch (git refuses if they clash).`);
    await warnLeaveDetached();
    plan.title = `Switch to ${ref.local ? ref.name : ref.short}`;
    return plan;
  }

  if (op === 'create') {
    const kind = body.kind === 'hotfix' ? 'hotfix' : 'feat';
    const slug = String(body.slug || '').trim();
    if (!WORKTREE_RE.test(slug)) return block('Short name may only contain letters, digits, . _ - and must not start with . or -.');
    const name = `${kind}/${stamp()}_${slug}`;
    if ((await git(dir, ['check-ref-format', '--branch', name], 3000)).code) return block(`Invalid branch name: ${name}`);
    let base;
    if (body.sha) {
      // "Tạo nhánh ở đây" từ một commit trên đồ thị.
      if (!SHA_RE.test(body.sha)) return block('Invalid SHA.');
      const full = (await git(dir, ['rev-parse', '-q', '--verify', `${body.sha}^{commit}`], 3000)).out.trim();
      if (!full) return block('Commit not found.');
      base = { name: full, short: full.slice(0, 8), remote: null };
      plan.warn.push(`Branching from commit ${base.short} — gitflow usually branches from the tip of staging.`);
    } else {
      base = pickRef(br, body.base);
      if (!/^(staging|develop|main|master)$/.test(base.short)) plan.warn.push(`Gitflow branches from staging — you picked ${base.name}.`);
    }
    if (base.remote) plan.steps.push({ args: ['fetch', base.remote, base.short, '--no-recurse-submodules'], timeout: 120000 });
    if (body.worktree) {
      const rel = `.worktrees/${slug}`;
      if (existsSync(join(r.dir, rel))) return block(`${rel} already exists.`);
      plan.steps.push({ args: ['worktree', 'add', rel, '-b', name, '--no-track', base.name], cwd: r.dir });
      plan.after = { kind: 'worktree', rel };
      plan.warn.push(`.worktrees will be added to .git/info/exclude (this machine only) if missing.`);
    } else {
      if (s.tracked) plan.warn.push(`${s.tracked} uncommitted file(s) will carry over to the new branch.`);
      plan.steps.push({ args: ['switch', '-c', name, '--no-track', base.name] });
    }
    plan.title = `Create ${name} from ${body.sha ? base.short : base.name}`;
    plan.branchName = name;
    plan.expect += '#' + name;   // qua phút mới giữa hai lần bấm thì tên đổi — bắt xem lại
    return plan;
  }

  // Kéo nhánh thả lên nhánh khác: `into` (merge) / `from` (rebase) là nhánh phải đứng ở HEAD.
  // Trang đã gửi sang worktree đang giữ nhánh đó (`away` = không phải worktree đang xem); nhánh
  // chưa worktree nào giữ thì switch worktree này sang nó trước.
  const onto = async (name, what) => {
    if (!name || name === s.branch) return null;
    const b = br.local.find((x) => x.name === name);
    if (!b) throw new Error(`Branch ${name} not found — refresh and try again.`);
    if (b.wtPath) throw new Error(`${name} is checked out in another worktree — refresh and try again.`);
    if (s.tracked) return block(`${s.tracked} tracked file(s) have uncommitted changes here — commit or stash before switching to ${name} to ${what}.`);
    plan.warn.push(`Switches ${t.wt ? wtShortName(t.wt) : 'the main worktree'} from ${s.branch || 'detached HEAD'} to ${name} first — ${name} is not checked out anywhere.`);
    return name;
  };
  const awayNote = (head) => { if (body.away) plan.warn.push(`Runs in ${t.wt ? wtShortName(t.wt) : 'the main worktree'}, where ${head} is checked out.`); };

  if (op === 'merge') {
    const sw = await onto(body.into, 'merge');
    if (plan.block) return plan;
    const head = sw || s.branch;
    if (!head) return block('Detached HEAD — switch to the target branch first.');
    const ref = pickRef(br, body.branch);
    if (ref.local && ref.name === head) return block('Cannot merge a branch into itself.');
    if (ref.short === 'develop' && PROTECTED_RE.test(head)) return block(`Never merge develop into ${head} (gitflow). Feature branches reach ${head} through a pull request.`);
    if (r.gitflow && PROTECTED_RE.test(head)) return block(`${head} only accepts changes through a pull request.`);
    if (needClean('merge')) return plan;
    const n = await countRev(dir, [`${sw || 'HEAD'}..${ref.name}`]);
    if (n === 0) return block(`${head} already contains every commit of ${ref.name}.`);
    if (ref.remote && ref.short === head) plan.warn.push(`Merging this branch's own remote copy — same as pull with merge.`);
    plan.title = `Merge ${ref.name} into ${head}`;
    const mergeArgs = ['merge', body.ff ? '--ff' : '--no-ff', '--no-edit', ref.name];
    if (sw) {
      plan.steps.push({ args: ['switch', sw] });
      // Sau switch HEAD đã là nhánh đích: bước merge soát theo nhánh đó.
      plan.steps.push({ args: mergeArgs, cwd: dir, branch: sw });
      plan.expect += '#' + sw;
    } else plan.steps.push({ args: mergeArgs });
    if (n != null) plan.warn.unshift(`Brings ${n} commit(s) from ${ref.name} into ${head}.`);
    awayNote(head);
    return plan;
  }

  if (op === 'rebase') {
    const sw = await onto(body.from, 'rebase it');
    if (plan.block) return plan;
    const head = sw || s.branch;
    if (!head) return block('Detached HEAD.');
    if (SHARED_RE.test(head)) return block(`${head} is a shared branch — never rebase it. Use merge.`);
    const ref = pickRef(br, body.branch);
    if (ref.local && ref.name === head) return block('Cannot rebase a branch onto itself.');
    if (needClean('rebase')) return plan;
    const p = await pushedInRange(dir, `${ref.name}..${sw || 'HEAD'}`);
    if (p.pushed == null) return block('Could not count commits already on the remote (git failed or timed out) — not rebasing without being sure.');
    if (p.pushed) return block(`${p.pushed}/${p.all} commit(s) that would be rewritten are already on the remote — rebasing would need a force push, which this project forbids. Use merge.`);
    if (!p.all) plan.warn.push('The branch has no commits of its own — rebase only moves it to the tip of the other branch.');
    plan.title = `Rebase ${head} onto ${ref.name}`;
    // `git rebase <base> <branch>` tự switch sang <branch> trước.
    plan.steps.push({ args: sw ? ['rebase', ref.name, sw] : ['rebase', ref.name] });
    if (sw) plan.expect += '#' + sw;
    awayNote(head);
    return plan;
  }

  if (op === 'abort') {
    if (!s.op) return block('No merge or rebase in progress.');
    plan.title = `Abort ${s.op}`;
    plan.warn.push('The working tree returns to its state before the operation — any conflict fixes are lost.');
    plan.steps.push({ args: [s.op, '--abort'] });
    return plan;
  }

  if (op === 'continue') {
    if (!s.op) return block('No merge or rebase in progress.');
    if (s.conflicts) return block(`${s.conflicts} file(s) still conflicted — fix them in your editor and mark them resolved (git add) first.`);
    // Merge dở có thể bắt đầu từ CLI/GUI — vẫn giữ luật như nút Merge.
    if (s.op === 'merge' && s.branch && PROTECTED_RE.test(s.branch)) {
      if (r.gitflow) return block(`${s.branch} only accepts changes through a pull request — abort this merge.`);
      const mh = (await git(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], 3000)).out.trim();
      const dev = await gitLines(dir, ['for-each-ref', '--format=%(objectname)', 'refs/heads/develop', 'refs/remotes/*/develop']);
      if (mh && dev.includes(mh)) return block(`This merges develop into ${s.branch} — gitflow forbids it. Abort this merge.`);
    }
    plan.title = `Continue ${s.op}`;
    plan.steps.push({ args: s.op === 'merge' ? ['commit', '--no-edit'] : [s.op, '--continue'] });
    return plan;
  }

  if (op === 'stage' || op === 'unstage') {
    plan.quiet = true;   // việc vặt, đảo lại được — không ghi vào Lệnh đã chạy nếu chạy êm
    const all = body.all === true;
    const want = Array.isArray(body.paths) ? body.paths : [];
    if (!all && (!want.length || want.some((p) => typeof p !== 'string'))) return block('No files selected.');
    const byPath = new Map(s.files.map((f) => [f.path, f]));
    const pick = all ? s.files : want.map((p) => byPath.get(p));
    if (pick.some((f) => !f)) return block('Some files no longer have changes — click Refresh.');
    if (op === 'stage') {
      let todo = pick.filter((f) => f.xy === '??' || f.xy === 'UU' || f.xy[1] !== '.');
      // Tệp bí mật chưa theo dõi (.env.local, khoá…) không bao giờ được stage từ trang:
      // chọn đích danh thì chặn, "Stage tất cả" thì bỏ qua và báo lại.
      const secret = todo.filter((f) => f.xy === '??' && isSecret(f.path));
      if (secret.length && !all) return block(`${secret[0].path} is a secret file — add it to .gitignore; this page will not stage it.`);
      if (secret.length) {
        todo = todo.filter((f) => !secret.includes(f));
        plan.warn.push(`Skipping ${secret.length} untracked secret file(s): ${secret.slice(0, 3).map((f) => f.path).join(', ')}${secret.length > 3 ? '…' : ''} — add them to .gitignore.`);
      }
      if (!todo.length) return block(secret.length ? 'Only untracked secret files remain — this page will not stage them.' : 'Nothing left to stage.');
      // Stage tệp xung đột = báo git đã sửa xong. Còn dấu <<<<<<< thì chưa xong thật.
      for (const f of todo.filter((x) => x.xy === 'UU')) {
        let txt = '';
        try { txt = await readFile(join(dir, f.path), 'utf8'); } catch {}
        if (/^(<{7}|>{7})( |$)/m.test(txt)) return block(`${f.path} still has conflict markers <<<<<<< / >>>>>>> — fix them before staging.`);
      }
      plan.title = all ? 'Stage all changes' : todo.length === 1 ? `Stage ${todo[0].path}` : `Stage ${todo.length} files`;
      // Luôn ghi đích danh từ cùng một lần đọc trạng thái — tệp (bí mật) sinh ra sau lúc
      // xem hộp không lọt vào.
      plan.steps.push({ args: ['add', '-A', '--', ...todo.map((f) => f.path)] });
    } else {
      // Tệp xung đột không bỏ stage được (git báo "unmerged") — bỏ qua chúng.
      const todo = pick.filter((f) => f.xy !== '??' && f.xy !== 'UU' && f.xy[0] !== '.');
      if (!todo.length) return block('No files are staged.');
      plan.title = all ? 'Unstage all files' : todo.length === 1 ? `Unstage ${todo[0].path}` : `Unstage ${todo.length} files`;
      plan.steps.push({ args: ['restore', '--staged', '--', ...todo.flatMap((f) => (f.orig ? [f.path, f.orig] : [f.path]))] });
    }
    return plan;
  }

  // Bỏ thay đổi chưa stage (khung Unstaged): tệp đã theo dõi lấy lại bản trong index
  // (`restore --worktree`, phần đã stage giữ nguyên), tệp chưa theo dõi bị xoá (`clean -f`).
  // Mất là mất hẳn nên luôn qua hộp xác nhận. Tệp bí mật chưa theo dõi không bao giờ xoá từ
  // trang; tệp xung đột thì sửa hoặc Abort chứ không discard.
  if (op === 'discard') {
    const all = body.all === true;
    const want = Array.isArray(body.paths) ? body.paths : [];
    if (!all && (!want.length || want.some((p) => typeof p !== 'string'))) return block('No files selected.');
    const byPath = new Map(s.files.map((f) => [f.path, f]));
    const pick = all ? s.files : want.map((p) => byPath.get(p));
    if (pick.some((f) => !f)) return block('Some files no longer have changes — click Refresh.');
    const conflict = pick.find((f) => f.xy === 'UU');
    if (conflict && pick.length === 1) return block(`${conflict.path} is conflicted — fix it and Mark resolved, or Abort the ${s.op || 'merge'}.`);
    let todo = pick.filter((f) => f.xy === '??' || (f.xy !== 'UU' && f.xy[1] !== '.'));
    const secret = todo.filter((f) => f.xy === '??' && isSecret(f.path));
    if (secret.length && !all) return block(`${secret[0].path} is an untracked secret file — this page will not delete it.`);
    if (secret.length) {
      todo = todo.filter((f) => !secret.includes(f));
      plan.warn.push(`Keeping ${secret.length} untracked secret file(s): ${secret.slice(0, 3).map((f) => f.path).join(', ')}${secret.length > 3 ? '…' : ''}.`);
    }
    if (!todo.length) return block('Nothing to discard.');
    const tracked = todo.filter((f) => f.xy !== '??'), untracked = todo.filter((f) => f.xy === '??');
    plan.title = all ? 'Discard all unstaged changes' : todo.length === 1 ? `Discard changes in ${todo[0].path}` : `Discard changes in ${todo.length} files`;
    if (tracked.length) plan.steps.push({ args: ['restore', '--worktree', '--', ...tracked.map((f) => f.path)] });
    if (untracked.length) plan.steps.push({ args: ['clean', '-f', '--', ...untracked.map((f) => f.path)] });
    plan.warn.push('Discarded changes cannot be recovered — git keeps no copy of them.');
    if (untracked.length) plan.warn.push(`${untracked.length} untracked file(s) will be deleted from disk.`);
    if (tracked.some((f) => f.xy[0] !== '.')) plan.warn.push('Staged changes in these files are kept — only the unstaged part is discarded.');
    if (conflict) plan.warn.push('Conflicted files are left as they are.');
    // Danh sách tệp đổi sau khi xem hộp xác nhận → không bỏ thứ PO chưa thấy.
    plan.expect += '#' + createHash('sha1').update(todo.map((f) => f.xy + f.path).join('\n')).digest('hex').slice(0, 12);
    return plan;
  }

  // Commit (nếu còn thay đổi) rồi merge nhánh của worktree này vào develop — bước "xong việc
  // → merge về develop" của gitflow. Merge chạy ở worktree đang giữ develop, luôn --no-ff,
  // không push. Xung đột thì để nguyên ở worktree develop để sửa tại đó: không bao giờ merge
  // develop ngược vào nhánh feat (PR feat → staging sẽ kéo theo cả develop).
  // Gỡ worktree (chuột phải ở thanh trái), tuỳ chọn xoá luôn nhánh local của nó. Chỉ gỡ cây
  // sạch: tệp chưa commit mất là mất hẳn. Nhánh còn commit không nằm ở remote hay nhánh
  // khác thì bắt tick ô xác nhận, và in SHA để lấy lại.
  if (op === 'remove-wt') {
    if (!t.wt) return block('The main worktree cannot be removed.');
    const w = t.wts.extra.find((x) => x.rel === t.wt), name = wtShortName(t.wt), home = t.wts.main?.path || r.real;
    if (w.locked) return block(`${name} is locked (git worktree lock) — unlock it first.`);
    const dirty = s.filesTotal ?? s.files.length;
    if (dirty) return block(`${dirty} file(s) in ${name} are not committed — commit or stash them first; removing the worktree would delete them.`);
    const procs = await procsIn(dir);
    if (!procs) return block('Could not list running processes (lsof failed) — not removing without being sure nothing runs from this folder.');
    const busy = procs.filter((p) => !SHELL_RE.test(p.command));
    if (busy.length) return block(`Still running from ${name}: ${busy.slice(0, 4).map((p) => `${p.command} (pid ${p.pid})`).join(', ')} — stop it first.`);
    if (procs.length) plan.warn.push(`${procs.length} terminal(s) are open inside ${name} — they will be left in a deleted folder.`);
    // Tệp bị .gitignore (.env.local, dist/…) không hiện trong status nhưng bị xoá cùng thư mục.
    const ign = (await gitLines(dir, ['status', '--porcelain', '--ignored=matching', '--untracked-files=normal']))
      .filter((ln) => ln.startsWith('!! ')).map((ln) => ln.slice(3));
    const links = [], gone = [];
    for (const p of ign) ((await lstat(join(dir, p.replace(/\/$/, ''))).catch(() => null))?.isSymbolicLink() ? links : gone).push(p);
    if (gone.length) plan.warn.push(`Ignored files are deleted too: ${gone.slice(0, 6).join(', ')}${gone.length > 6 ? ` and ${gone.length - 6} more` : ''}.`);
    if (links.length) plan.warn.push(`Symlinks removed (their targets stay): ${links.slice(0, 4).join(', ')}.`);
    // Worktree có submodule: git đòi --force kể cả khi sạch. Status ở trên đã gồm submodule.
    const sub = existsSync(join(dir, '.gitmodules'));
    plan.steps.push({ args: ['worktree', 'remove', ...(sub ? ['--force'] : []), t.wt], cwd: home, where: 'main worktree' });
    if (sub) plan.warn.push('The worktree has submodules — git needs --force for that; it is clean, nothing uncommitted is lost.');
    plan.title = `Remove worktree ${name}`;
    if (body.deleteBranch) {
      const b = w.branch;
      if (!b) return block(`${name} is on a detached HEAD — there is no branch to delete.`);
      if (SHARED_RE.test(b)) return block(`${b} is a shared branch — it is never deleted from here.`);
      // Commit chỉ có ở nhánh này: không nằm trên remote nào, không nằm trên nhánh local khác.
      const only = await countRev(dir, [b, '--not', '--remotes', `--exclude=${b}`, '--branches']);
      if (only == null) return block(`Could not check whether ${b} has commits found nowhere else — not deleting it.`);
      if (only) {
        plan.warn.push(`${only} commit(s) exist only on ${b}. To get them back later (until git gc): git branch ${b} ${s.oid}`);
        plan.ack = `I understand the ${only} commit(s) found only on ${b} will no longer be on any branch.`;
      } else plan.warn.push(`Every commit of ${b} is already on a remote or another branch — nothing is lost.`);
      if (s.upstream) plan.warn.push(`The remote branch ${s.upstream} is not deleted.`);
      plan.steps.push({ args: ['branch', '-D', b], cwd: home, where: 'main worktree' });
      plan.title += ` and branch ${b}`;
    }
    plan.removedWt = t.wt;
    plan.removedPath = dir;
    plan.expect += `#rm:${body.deleteBranch ? 1 : 0}`;
    return plan;
  }

  // Xoá nhánh (chuột phải ở thanh trái). Nhánh local: không phải nhánh đang mở ở worktree nào.
  // Nhánh remote: git push --delete. Commit chỉ có ở nhánh bị xoá (không nằm trên nhánh local
  // hay remote nào khác) thì bắt tick ô xác nhận và in SHA để lấy lại. `expect` kèm SHA của
  // nhánh: nhánh đổi giữa lúc xem hộp và lúc bấm thì dừng.
  if (op === 'delete-branch' || op === 'delete-remote') {
    const local = op === 'delete-branch';
    const ref = pickRef(br, body.branch);
    if (ref.local !== local) throw new Error(`Branch ${body.branch} not found — refresh and try again.`);
    if (SHARED_RE.test(ref.short)) return block(`${ref.short} is a shared branch — it is never deleted from here.`);
    const full = `refs/${local ? 'heads' : 'remotes'}/${ref.name}`;
    const oid = (await git(dir, ['rev-parse', '--verify', '--quiet', full])).out.trim();
    if (!oid) throw new Error(`Branch ${ref.name} not found — refresh and try again.`);
    if (local) {
      const b = br.local.find((x) => x.name === ref.name);
      if (ref.name === s.branch) return block(`${ref.name} is the current branch — switch to another branch first.`);
      if (b.wtPath) return block(`${ref.name} is checked out in ${b.wtPath} — switch that worktree to another branch or remove it first.`);
    }
    const only = await countRev(dir, local
      ? [full, '--not', '--remotes', `--exclude=${ref.name}`, '--branches']
      : [full, '--not', '--branches', `--exclude=${ref.name}`, '--remotes']);
    if (only == null) return block(`Could not check whether ${ref.name} has commits found nowhere else — not deleting it.`);
    if (only) {
      plan.warn.push(`${only} commit(s) exist only on ${ref.name}. To get them back later (until git gc): git branch ${ref.short} ${oid}`);
      plan.ack = `I understand the ${only} commit(s) found only on ${ref.name} will no longer be on any branch.`;
    } else plan.warn.push(`Every commit of ${ref.name} is already on another branch — nothing is lost.`);
    if (local) {
      const b = br.local.find((x) => x.name === ref.name);
      if (b.upstream && b.track !== '[gone]') plan.warn.push(`The remote branch ${b.upstream} is not deleted.`);
      plan.steps.push({ args: ['branch', '-D', ref.name] });
      plan.title = `Delete branch ${ref.name}`;
    } else {
      plan.warn.push(`This deletes ${ref.short} on ${ref.remote} for everyone — an open pull request from it gets closed. Checked against your last fetch.`);
      const by = br.local.filter((x) => x.upstream === ref.name).map((x) => x.name);
      if (by.length) plan.warn.push(`Local branch ${by.join(', ')} tracks it — the local branch is kept.`);
      plan.steps.push({ args: ['push', ref.remote, '--delete', `refs/heads/${ref.short}`], timeout: 120000, progress: true });
      plan.title = `Delete ${ref.short} from ${ref.remote}`;
    }
    plan.expect += `#del:${ref.name}@${oid}`;
    return plan;
  }

  if (op === 'ship') {
    if (!s.branch) return block('Detached HEAD — switch to a branch first.');
    if (SHARED_RE.test(s.branch)) return block(`${s.branch} is a shared branch — only feature branches are merged into develop.`);
    if (s.conflicts) return block(`${s.conflicts} file(s) still conflicted.`);
    const wts = t.wts;
    const holder = [wts.main, ...wts.extra].find((w) => w?.branch === 'develop');
    if (!holder) return block('develop is not checked out in any worktree — switch the main worktree to develop, then try again.');
    const devWt = holder === wts.main ? '' : holder.rel, devAt = devWt ? wtShortName(devWt) : 'main worktree';
    const here = t.wt ? wtShortName(t.wt) : 'main worktree';
    const d2 = await gitStatus(holder.path, 'no', 0);
    if (d2.error) throw new Error(d2.error);
    if (d2.op) return block(`A ${d2.op} is in progress in ${devAt} (develop) — finish or abort it there first.`);
    if (d2.tracked) return block(`${devAt} (develop) has ${d2.tracked} uncommitted file(s) — commit or stash them there first; a merge on top of them cannot be undone cleanly.`);

    // Phần commit: "staged" = như nút Commit; "all" = stage mọi thay đổi trước (bỏ tệp bí mật chưa theo dõi).
    const mode = body.mode === 'all' ? 'all' : 'staged';
    let todo = [];
    if (mode === 'all') {
      todo = s.files.filter((f) => f.xy === '??' || f.xy[1] !== '.');
      const secret = todo.filter((f) => f.xy === '??' && isSecret(f.path));
      if (secret.length) {
        todo = todo.filter((f) => !secret.includes(f));
        plan.warn.push(`Skipping ${secret.length} untracked secret file(s): ${secret.slice(0, 3).map((f) => f.path).join(', ')}${secret.length > 3 ? '…' : ''} — add them to .gitignore.`);
      }
    }
    const inCommit = s.files.filter((f) => (f.xy !== '??' && f.xy[0] !== '.') || todo.includes(f));
    if (inCommit.length) {
      const msg = commitMessage(body);
      if (msg.err) return block(msg.err);
      const who = await commitAuthor(dir);
      if (who.err) return block(who.err);
      if (todo.length) plan.steps.push({ args: ['add', '-A', '--', ...todo.map((f) => f.path)], where: here });
      plan.steps.push({ args: msg.args, timeout: 120000, where: here });
      plan.warn.push(`${inCommit.length} file(s) in the commit on ${s.branch} · author ${who.text}`);
      const secret = inCommit.filter((f) => isSecret(f.path));
      if (secret.length) {
        plan.warn.push(`Secret files in this commit: ${secret.slice(0, 3).map((f) => f.path).join(', ')}${secret.length > 3 ? '…' : ''}. Once in history they are very hard to remove.`);
        plan.ack = 'I have opened these files and I am sure they contain no passwords, tokens or keys.';
      }
    }
    const left = s.files.length - inCommit.length;
    if (left) plan.warn.push(`${left} file(s) stay uncommitted in ${here} — they are not merged.`);

    const n = await countRev(dir, [`develop..${s.branch}`]);
    if (!inCommit.length && n === 0) return block(`develop already contains every commit of ${s.branch} — nothing to commit or merge.`);
    if (d2.behind && body.ffDevelop) {
      if (d2.ahead) return block(`develop has diverged from ${d2.upstream} (↑${d2.ahead} ↓${d2.behind}) — pull develop with merge first.`);
      plan.steps.push({ args: ['merge', '--ff-only', d2.upstream], cwd: holder.path, branch: 'develop', where: devAt });
    } else if (d2.behind) plan.warn.push(`Local develop is ${d2.behind} commit(s) behind ${d2.upstream} — pull develop before you push it.`);
    plan.steps.push({ args: ['merge', '--no-ff', '--no-edit', s.branch], cwd: holder.path, branch: 'develop', where: devAt });
    if (n != null) plan.warn.unshift(`Brings ${n + (inCommit.length ? 1 : 0)} commit(s) from ${s.branch} into develop.`);
    plan.warn.push('Nothing is pushed — push develop when you are ready.');
    plan.title = inCommit.length ? `Commit & merge ${s.branch} into develop` : `Merge ${s.branch} into develop`;
    plan.devWt = devWt;
    plan.devDir = holder.path;
    // Tệp sẽ commit, cách chọn, hay develop đổi sau lúc xem hộp → bắt xem lại.
    plan.expect += `|develop@${d2.oid || ''}#` + createHash('sha1')
      .update([mode, body.ffDevelop ? 'ff' : '', ...inCommit.map((f) => f.xy + f.path)].join('\n')).digest('hex').slice(0, 12);
    return plan;
  }

  if (op === 'commit') {
    if (!s.branch) return block('Detached HEAD — create or switch to a branch before committing.');
    if (r.gitflow && PROTECTED_RE.test(s.branch)) return block(`${s.branch} only accepts changes through a pull request — create a feat branch and commit there.`);
    if (s.conflicts) return block(`${s.conflicts} file(s) still conflicted.`);
    if (!s.staged) return block('Nothing staged — move files to Staged first.');
    const msg = commitMessage(body);
    if (msg.err) return block(msg.err);
    const who = await commitAuthor(dir);
    if (who.err) return block(who.err);
    const staged = s.files.filter((f) => f.xy !== '??' && f.xy[0] !== '.');
    plan.warn.push(`${staged.length} file(s) in this commit · author ${who.text}`);
    const secret = staged.filter((f) => isSecret(f.path));
    if (secret.length) {
      plan.warn.push(`Secret files in this commit: ${secret.slice(0, 3).map((f) => f.path).join(', ')}${secret.length > 3 ? '…' : ''}. Once in history they are very hard to remove.`);
      plan.ack = 'I have opened these files and I am sure they contain no passwords, tokens or keys.';
    }
    if (s.unstaged || s.untracked) plan.warn.push('Unstaged files are not part of this commit — they stay in the working tree.');
    if (s.branch === 'develop') plan.warn.push('Committing straight to develop — usually you work on a feat branch and merge it in.');
    plan.title = `Commit to ${s.branch}`;
    plan.steps.push({ args: msg.args, timeout: 120000 });   // hook (lint…) có thể chạy lâu
    // Danh sách tệp stage đổi sau khi xem hộp xác nhận → không commit thứ PO chưa thấy.
    plan.expect += '#' + createHash('sha1').update(staged.map((f) => f.xy[0] + f.path).join('\n')).digest('hex').slice(0, 12);
    return plan;
  }

  // Checkout một commit = HEAD tách rời ở đó (switch --detach): xem, build, chạy thử bản cũ. Không nhánh nào bị đổi.
  if (op === 'checkout') {
    const sha = typeof body.sha === 'string' && SHA_RE.test(body.sha) ? body.sha : '';
    if (!sha) return block('No commit selected.');
    const full = (await git(dir, ['rev-parse', '-q', '--verify', `${sha}^{commit}`], 3000)).out.trim();
    if (!full) return block(`Commit ${sha.slice(0, 8)} not found — click Refresh.`);
    if (full === s.oid) return block(s.branch ? `${s.branch} is already at ${full.slice(0, 8)} — nothing to check out.` : `HEAD is already at ${full.slice(0, 8)}.`);
    await warnLeaveDetached();
    const at = (await git(dir, ['for-each-ref', '--points-at', full, '--format=%(refname:short)', 'refs/heads'], 3000)).out.split('\n').filter(Boolean);
    plan.title = `Checkout ${full.slice(0, 8)} (detached HEAD)`;
    plan.steps.push({ args: ['switch', '--detach', full], timeout: 60000 });
    plan.warn.push(`HEAD will point at commit ${full.slice(0, 8)}, not at a branch — fine for reading, building or testing an old version. New commits here belong to no branch: use New branch… to keep them. Switch to a branch in the sidebar to go back.`);
    if (at.length) plan.warn.push(`${at.join(', ')} point${at.length === 1 ? 's' : ''} at this commit — switch to ${at.length === 1 ? 'that branch' : 'one of them'} instead if you want to commit.`);
    if (s.tracked) plan.warn.push(`${s.tracked} uncommitted file(s) will carry over (git refuses if they clash with the files of that commit).`);
    return plan;
  }

  // Revert = thêm một commit đảo ngược commit cũ; lịch sử giữ nguyên nên an toàn cả khi đã push.
  if (op === 'revert') {
    if (!s.branch) return block('Detached HEAD — switch to a branch before reverting.');
    if (r.gitflow && PROTECTED_RE.test(s.branch)) return block(`${s.branch} only accepts changes through a pull request — revert on a feat branch and merge it in.`);
    if (needClean('revert')) return plan;
    const sha = typeof body.sha === 'string' && /^[0-9a-f]{7,40}$/i.test(body.sha) ? body.sha : '';
    if (!sha) return block('No commit selected.');
    const full = (await git(dir, ['rev-parse', '-q', '--verify', `${sha}^{commit}`], 3000)).out.trim();
    if (!full) return block(`Commit ${sha.slice(0, 8)} not found — click Refresh.`);
    if (!(await git(dir, ['merge-base', '--is-ancestor', full, 'HEAD'], 5000)).ok) return block(`${full.slice(0, 8)} is not part of ${s.branch} — only commits already on the current branch can be reverted.`);
    const [parents = '', subj = ''] = (await git(dir, ['log', '-1', '--format=%P%x00%s', full], 3000)).out.trim().split('\0');
    const nPar = parents ? parents.split(' ').length : 0;
    if (!nPar) return block('Reverting the first commit of the repository is not supported — it would delete the files the project started with.');
    const who = await commitAuthor(dir);
    if (who.err) return block(who.err);
    plan.title = `Revert ${full.slice(0, 8)} on ${s.branch}`;
    plan.steps.push({ args: ['revert', '--no-edit', ...(nPar > 1 ? ['-m', '1'] : []), full], timeout: 120000 });
    plan.warn.push(`Adds a new commit "Revert "${subj}"" on top of ${s.branch} · author ${who.text}. Nothing is rewritten — safe even if the commit is already pushed.`);
    if (nPar > 1) plan.warn.push('This is a merge commit — it is reverted against its first parent (-m 1), undoing everything the merge brought in. Merging that branch again later will NOT bring those changes back; you would have to revert this revert.');
    plan.warn.push('If later commits changed the same lines, the revert stops with conflicts — fix them, then Continue or Abort.');
    plan.expect += '#' + full;
    return plan;
  }

  if (op === 'stash') {
    if (!s.files.length) return block('Working tree is clean — nothing to stash.');
    const msg = typeof body.message === 'string' ? body.message.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
    plan.title = `Stash changes on ${s.branch || 'detached HEAD'}`;
    const what = [s.tracked && `${s.tracked} tracked file(s)`, s.untracked && `${s.untracked} untracked file(s)/folder(s)`].filter(Boolean).join(' and ');
    plan.warn.push(`Stashes ${what} — the working tree becomes clean; restore with Pop.`);
    plan.warn.push('The stash list is shared by every worktree of this repository.');
    const secret = s.files.filter((f) => f.xy === '??' && isSecret(f.path));
    if (secret.length) {
      plan.warn.push(`The stash also takes untracked secret files: ${secret.slice(0, 3).map((f) => f.path).join(', ')}${secret.length > 3 ? '…' : ''} — apps reading them will miss their config until you Pop.`);
      plan.ack = 'I understand these files leave the working tree until I Pop.';
    }
    plan.steps.push({ args: ['stash', 'push', '--include-untracked', ...(msg ? ['-m', msg] : [])] });
    // Tệp sinh ra sau lúc xem hộp cũng bị cất — đổi danh sách thì bắt bấm lại.
    plan.expect += '#' + createHash('sha1').update(s.files.map((f) => f.xy + f.path).join('\n')).digest('hex').slice(0, 12);
    return plan;
  }

  if (op === 'pop') {
    const items = (await gitLines(dir, ['stash', 'list', '--format=%H%x09%gd%x09%gs']))
      .map((ln) => { const [hash, ref, ...m] = ln.split('\t'); return { hash, ref, subject: m.join('\t') }; });
    if (!items.length) return block('No stashes.');
    // Chọn theo hash chứ không theo stash@{n}: có stash mới chen vào thì số thứ tự trôi.
    const it = body.hash ? items.find((x) => x.hash === body.hash) : items[0];
    if (!it) return block('This stash no longer exists — click Refresh.');
    if (s.conflicts) return block(`${s.conflicts} file(s) still conflicted.`);
    plan.title = `Pop ${it.ref}`;
    plan.warn.push(`Restores: ${it.subject}`);
    const from = /^(?:WIP on|On) ([^:]+):/.exec(it.subject)?.[1];
    if (from && from !== s.branch) plan.warn.push(`This stash was made on ${from}; you are on ${s.branch || 'detached HEAD'}.`);
    if (s.tracked) plan.warn.push(`${s.tracked} uncommitted file(s) — pop may conflict; if so, git keeps the stash.`);
    plan.warn.push('A clean pop removes the stash from the list.');
    plan.steps.push({ args: ['stash', 'pop', it.ref] });
    return plan;
  }

  throw new Error(`Unknown operation: ${op}`);
}

const cmdText = (args) => `git ${args.map(q).join(' ')}`;

async function ensureWorktreeExclude(dir) {
  const common = (await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 3000)).out.trim();
  if (!common) return null;
  const f = join(common, 'info', 'exclude');
  let txt = '';
  try { txt = await readFile(f, 'utf8'); } catch {}
  if (/^\/?\.worktrees\/?$/m.test(txt)) return null;
  await mkdir(dirname(f), { recursive: true });
  await writeFile(f, txt + (txt && !txt.endsWith('\n') ? '\n' : '') + '.worktrees\n');
  return `Add .worktrees to ${f}`;
}

// Worktree mới không có node_modules. Bật `linkNodeModules` ở git.json thì nối symlink về
// cây chính cho mọi thư mục có package.json được theo dõi (sâu tối đa 3 tầng), để chạy được ngay.
async function linkNodeModules(repo, wtDir) {
  if (!linkDeps) return [];
  const apps = (await gitLines(wtDir, ['ls-files', '--', 'package.json', '*/package.json', '*/*/package.json', '*/*/*/package.json']))
    .map((f) => dirname(f)).map((d) => (d === '.' ? '' : d)).slice(0, 40);
  const done = [];
  for (const a of apps) {
    const from = join(repo.dir, a, 'node_modules');
    const to = join(wtDir, a, 'node_modules');
    if (!existsSync(from) || existsSync(to) || !existsSync(join(wtDir, a, 'package.json'))) continue;
    try { await symlink(from, to); done.push(`${a || '.'}/node_modules`); } catch {}
  }
  return done;
}

// Dòng tiến độ của git: "Writing objects:  45% (9/20), 1.20 MiB | 2.30 MiB/s", nối nhau bằng \r.
const PROGRESS_RE = /^(?:remote: )?(Enumerating objects|Counting objects|Compressing objects|Writing objects|Receiving objects|Resolving deltas|Unpacking objects)\b/;
function progressOf(chunk) {
  const line = chunk.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).pop();
  if (!line) return {};
  const m = PROGRESS_RE.exec(line), pct = /:\s+(\d{1,3})%/.exec(line);
  // Dòng không phải tiến độ ("Total 3 (delta 0)…", "remote: …") thì giữ giai đoạn/phần trăm trước đó.
  const out = { line: hideCred(line).slice(0, 200) };
  return m ? { ...out, phase: m[1], pct: pct ? Math.min(100, +pct[1]) : null } : out;
}
// Bỏ các dòng tiến độ khỏi output lưu vào Command history — chỉ giữ thông báo thật của git/remote.
const dropProgress = (err) => err.split('\n').map((l) => l.split('\r').pop())
  .filter((l) => !PROGRESS_RE.test(l.trim()) && !/^(?:remote: )?(Delta compression using|Total \d)/.test(l.trim())).join('\n');

const planView = ({ devDir, removedPath, ...plan }, dryRun) => ({ ...plan, dryRun, steps: plan.steps.map((x) => ({ cmd: cmdText(x.args), where: x.where || null })) });

async function headBranch(dir) {
  const r = await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'], 3000);
  return r.ok ? r.out.trim() : null;
}

async function gitRun(body) {
  if (body.dryRun) return planView(await gitPlan(body), true);
  // Lệnh ghi phải đi qua hộp xác nhận: không có `expect` (lấy từ dry-run) thì không chạy.
  if (!GIT_QUICK_OPS.has(body.op) && typeof body.expect !== 'string') throw new Error('Missing confirmation step — call dryRun first.');
  // Khoá repo từ lúc lập kế hoạch tới hết lệnh: hai lệnh từ trang không chen nhau giữa
  // bước soát luật và bước chạy. Git CLI/GUI ngoài trang thì không khoá được — nên còn
  // so HEAD với lúc PO xem hộp xác nhận, và trước từng bước.
  const { r, dir, wt } = await gitTarget(body);
  if (gitBusy.has(r.real)) throw new Error('This repository is already running another command — wait for it to finish.');
  gitBusy.add(r.real);
  const steps = [];
  let ok = true, plan;
  try {
    plan = await gitPlan(body);
    if (plan.block) return planView(plan, false);
    if (plan.ack && body.ack !== true) return planView({ ...plan, block: 'Tick the confirmation box in the dialog before running.' }, false);
    if (body.expect && body.expect !== plan.expect) {
      return planView({ ...plan, block: 'The repository changed branch or commit after you opened the confirmation — try again to review the new commands.' }, false);
    }
    if (plan.after?.kind === 'worktree') {
      const note = await ensureWorktreeExclude(r.dir);
      if (note) steps.push({ cmd: note, code: 0, out: '' });
    }
    for (const [i, st] of plan.steps.entries()) {
      // Bước chạy ở worktree khác (merge vào develop) mang nhánh riêng để soát; bước tạo worktree thì không.
      const want = st.cwd ? st.branch : plan.branch;
      if (want !== undefined && body.op !== 'fetch' && (await headBranch(st.cwd || dir)) !== want) {
        steps.push({ cmd: cmdText(st.args), where: st.where || null, code: 'skip', out: `Stopped: HEAD is no longer on ${want || 'detached'} (a git command outside this page got in between).` });
        ok = false; break;
      }
      const live = { cmd: cmdText(st.args), step: i + 1, of: plan.steps.length, phase: '', pct: null, line: '' };
      gitRunning.set(r.real, live);
      // Không có TTY thì git không in tiến độ — `--progress` bật lại; chỉ thêm lúc chạy để hộp
      // xác nhận và Command history vẫn hiện đúng lệnh PO đã duyệt.
      const args = st.progress ? [st.args[0], '--progress', ...st.args.slice(1)] : st.args;
      const res = await git(st.cwd || dir, args, st.timeout || 30000, st.progress ? (t) => Object.assign(live, progressOf(t)) : null);
      if (st.progress) res.err = dropProgress(res.err);
      const out = hideCred((res.out + (res.err ? (res.out ? '\n' : '') + res.err : '')).trimEnd())
        || (res.code === 'timeout' ? 'Timed out — check the network or your SSH key (this page cannot enter passwords).' : '');
      steps.push({ cmd: cmdText(st.args), code: res.code, out, where: st.where || null });
      if (!res.ok) { ok = false; break; }
    }
    if (ok && plan.after?.kind === 'worktree') {
      const linked = await linkNodeModules(r, join(r.dir, plan.after.rel));
      if (linked.length) steps.push({ cmd: `Symlink ${linked.join(', ')} to the main worktree`, code: 0, out: '' });
    }
    // Merge vào develop vướng xung đột: báo trang worktree develop để mở ra sửa (hoặc Abort).
    if (!ok && plan.devDir && (await gitStatus(plan.devDir, 'no', 0)).op === 'merge') plan.conflictWt = plan.devWt;
    // Kéo thả merge / rebase ở worktree khác vướng xung đột: cũng mở worktree đó.
    else if (!ok && body.away && (await gitStatus(dir, 'no', 0)).op) plan.conflictWt = wt;
  } finally {
    gitBusy.delete(r.real);
    gitRunning.delete(r.real);
  }
  const entry = { t: Date.now(), repo: r.label, wt, title: plan.title, ok, steps };
  if (!(plan.quiet && ok)) gitHistory = [entry, ...gitHistory].slice(0, GIT_HISTORY_MAX);
  return { ...entry, warn: plan.warn, branchName: plan.branchName || null, newWt: ok && plan.after?.kind === 'worktree' ? plan.after.rel : null, removedWt: plan.removedWt && !existsSync(plan.removedPath) ? plan.removedWt : null, conflictWt: plan.conflictWt ?? null };
}

// Repo lẻ, không thuộc nhóm project nào — người dùng thêm bằng đường dẫn tuyệt đối.
async function gitAddExtra(body) {
  if (body.remove) {
    gitExtra = gitExtra.filter((p) => p !== body.remove);
  } else {
    const p = normPath(body.path);
    if (!existsSync(join(p, '.git'))) throw new Error(`${p} is not the root of a git repository (no .git).`);
    if (!gitExtra.includes(p)) gitExtra.push(p);
  }
  await saveConf();
  return gitList(true);
}

// ─── Git cloud accounts ───
// Like Sourcetree's Accounts: sign in to GitHub, GitLab or Bitbucket with a personal access
// token. The token is handed to git's own credential helper (`git credential approve`), so
// fetch/push here, in the Terminal tray and in agents' terminals all use it. git.json only keeps
// who is signed in where. The provider API is called to check the token and to list
// repositories for the Clone dialog; the token is read back from the helper each time.
const SERVICES = {
  github: { label: 'GitHub', host: 'github.com', api: (h) => (h === 'github.com' ? 'https://api.github.com' : `https://${h}/api/v3`) },
  gitlab: { label: 'GitLab', host: 'gitlab.com', api: (h) => `https://${h}/api/v4` },
  bitbucket: { label: 'Bitbucket', host: 'bitbucket.org', api: () => 'https://api.bitbucket.org/2.0' },
  other: { label: 'Other host', host: '' },
};
const HOST_RE = /^(?=.{1,253}(:|$))[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;
const USER_RE = /^[^\s:/\\@\0]{1,100}$/;
const EMAIL_RE = /^[^\s@\0]+@[^\s@\0]+$/;
let gitAccounts = [];
let cloneDir = null;   // last folder cloned into
const REPO_PAGES = 3;

// The credential protocol is key=value lines: refuse anything that could add a line.
function gitCred(op, fields) {
  return new Promise((done) => {
    const child = execFile('git', ['-c', 'credential.interactive=never', 'credential', op], {
      timeout: 20000, killSignal: 'SIGKILL',
      env: { ...GIT_ENV, GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never' },
    }, (e, so, se) => done({ ok: !e, out: so || '', err: (se || '').trim() }));
    child.stdin.on('error', () => {});
    child.stdin.end(Object.entries(fields).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('\n') + '\n\n');
  });
}

async function tokenOf(a) {
  const r = await gitCred('fill', { protocol: 'https', host: a.host, username: a.username });
  const pw = r.ok && r.out.match(/^password=(.*)$/m)?.[1];
  if (!pw) throw new Error(`The token for ${a.username} on ${a.host} is no longer in git's credential helper — remove the account and add it again.`);
  return pw;
}

// Last credential.helper git would use (an empty value resets the list), or null.
async function credHelper() {
  const r = await git(homedir(), ['config', '--get-all', 'credential.helper']);
  const list = r.out.replace(/\n$/, '').split('\n');
  return list.slice(list.lastIndexOf('') + 1).pop() || null;
}
const SUGGEST_HELPER = { darwin: 'osxkeychain', win32: 'manager' }[process.platform] || null;

async function cloudApi(a, token, path) {
  const headers = { accept: 'application/json', 'user-agent': 'GitMenorah' };
  if (a.service === 'github') headers.authorization = `Bearer ${token}`;
  else if (a.service === 'gitlab') headers['private-token'] = token;
  else headers.authorization = `Basic ${Buffer.from(`${a.email}:${token}`).toString('base64')}`;
  let res;
  // No redirects: a custom header such as PRIVATE-TOKEN would follow them to another host.
  try { res = await fetch(SERVICES[a.service].api(a.host) + path, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw new Error(`Could not reach ${a.host}: ${e.cause?.message || e.message}`); }
  if (res.status === 401 || res.status === 403) throw new Error(`${a.host} rejected the token (HTTP ${res.status}). Check that it is valid and has the scopes listed.`);
  if (!res.ok) throw new Error(`${a.host} answered HTTP ${res.status}.`);
  return res.json();
}

const accountView = (a) => ({ ...a, label: SERVICES[a.service].label });
const accountsView = async () => ({ accounts: gitAccounts.map(accountView), helper: await credHelper(), suggestHelper: SUGGEST_HELPER, cloneDir });

async function accountAdd(b) {
  const service = Object.hasOwn(SERVICES, b.service) ? b.service : null;
  if (!service) throw new Error('Pick GitHub, GitLab, Bitbucket or another host.');
  const host = service === 'bitbucket' ? 'bitbucket.org'
    : String(b.host || SERVICES[service].host).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!HOST_RE.test(host)) throw new Error('Enter a host name, e.g. github.com or gitlab.example.com.');
  const token = String(b.token || '').trim();
  if (!token) throw new Error('Paste a personal access token.');
  if (/[\s\0]/.test(token)) throw new Error('The token has spaces or line breaks in it — copy it again.');
  const a = { id: 'a' + Date.now().toString(36), service, host, username: '', email: '', name: '', protocol: b.protocol === 'ssh' ? 'ssh' : 'https', addedAt: Date.now() };
  if (service === 'bitbucket') {
    a.email = String(b.email || '').trim();
    if (!EMAIL_RE.test(a.email)) throw new Error('Enter the email of your Atlassian account — Bitbucket checks API tokens against it.');
  }
  if (service === 'other') {
    a.username = String(b.username || '').trim();
    if (!USER_RE.test(a.username)) throw new Error('Enter the username for this host.');
  } else {
    const u = await cloudApi(a, token, '/user');
    a.username = String(u.login || u.username || '');
    a.name = String(u.name || u.display_name || '').slice(0, 100);
    if (!USER_RE.test(a.username)) throw new Error(`${host} did not return a usable username.`);
  }
  const helper = await credHelper();
  if (!helper) throw new Error('Git has no credential helper, so it cannot remember the token. Turn one on first.');
  const r = await gitCred('approve', { protocol: 'https', host, username: a.username, password: token });
  if (!r.ok) throw new Error(`git credential approve failed: ${r.err || 'no output'}`);
  if (await tokenOf(a).catch(() => null) !== token) throw new Error(`The credential helper "${helper}" did not keep the token, so git could not use it.`);
  // Signing in again as the same user replaces the token but keeps the account's id.
  const old = gitAccounts.find((x) => x.host === host && x.username === a.username);
  if (old) a.id = old.id;
  gitAccounts = [...gitAccounts.filter((x) => x !== old), a];
  await saveConf();
  return { ...(await accountsView()), added: accountView(a) };
}

const toRepo = (name, https, ssh, priv, desc, at) => ({ name, https, ssh, private: !!priv, description: String(desc || '').slice(0, 200), updatedAt: Date.parse(at) || 0 });
async function accountRepos(a) {
  const token = await tokenOf(a);
  const out = [];
  for (let page = 1; page <= REPO_PAGES; page++) {
    let got;
    if (a.service === 'github') {
      got = (await cloudApi(a, token, `/user/repos?per_page=100&sort=pushed&page=${page}`))
        .map((x) => toRepo(x.full_name, x.clone_url, x.ssh_url, x.private, x.description, x.pushed_at));
    } else if (a.service === 'gitlab') {
      got = (await cloudApi(a, token, `/projects?membership=true&simple=true&order_by=last_activity_at&per_page=100&page=${page}`))
        .map((x) => toRepo(x.path_with_namespace, x.http_url_to_repo, x.ssh_url_to_repo, x.visibility !== 'public', x.description, x.last_activity_at));
    } else {
      const j = await cloudApi(a, token, `/repositories?role=member&sort=-updated_on&pagelen=100&page=${page}`);
      const link = (x, k) => (x.links?.clone || []).find((c) => c.name === k)?.href || '';
      got = (j.values || []).map((x) => toRepo(x.full_name, link(x, 'https'), link(x, 'ssh'), x.is_private, x.description, x.updated_on));
    }
    out.push(...got);
    if (got.length < 100) break;
  }
  return { repos: out };
}

async function gitAccountOp(b) {
  if (b.op === 'add') return accountAdd(b);
  if (b.op === 'use-helper') {
    if (!SUGGEST_HELPER) throw new Error('Set credential.helper yourself — see git help credential.');
    if (!(await credHelper())) {
      const r = await git(homedir(), ['config', '--global', 'credential.helper', SUGGEST_HELPER]);
      if (!r.ok) throw new Error(r.err.trim() || 'git config failed.');
    }
    return accountsView();
  }
  const a = gitAccounts.find((x) => x.id === b.id);
  if (!a) throw new Error('No such account.');
  if (b.op === 'repos') {
    if (a.service === 'other') throw new Error(`GitMenorah cannot list repositories on ${a.host} — paste the URL.`);
    return accountRepos(a);
  }
  if (b.op === 'remove') {
    await gitCred('reject', { protocol: 'https', host: a.host, username: a.username });
    gitAccounts = gitAccounts.filter((x) => x !== a);
    await saveConf();
    return accountsView();
  }
  throw new Error('Unknown account action.');
}

// ─── Clone ───
// Runs in the background: POST starts it, GET ?job= reports progress. The clone joins the
// project group whose folder holds it, otherwise the list of other repositories.
const CLONE_URL_RE = /^((https?|ssh|git):\/\/[^\s/]+\/\S+|[\w.-]+@[\w.-]+:(?!\/\/)\S+)$/;
const cloneJobs = new Map();   // id → { id, dir, cmd, done, ok, progress, error }

// https://host/a/b.git signed in as `user` → https://user@host/a/b.git, so the credential
// helper picks that account's token when several accounts share a host.
function withUser(url, a) {
  const m = url.match(/^https:\/\/([^/@]+)(\/.*)$/);
  return m && m[1].toLowerCase() === a.host ? `https://${encodeURIComponent(a.username)}@${m[1]}${m[2]}` : url;
}
const repoNameOf = (url) => (String(url).replace(/[?#].*$/, '').replace(/\/+$/, '').split(/[/:]/).pop() || '').replace(/\.git$/i, '');

async function gitClone(b) {
  let url = String(b.url || '').trim();
  if (!CLONE_URL_RE.test(url)) throw new Error('Enter a repository URL — https://…, ssh://… or git@host:owner/repo.git.');
  if (b.account) {
    const a = gitAccounts.find((x) => x.id === b.account);
    if (!a) throw new Error('That account is no longer signed in.');
    url = withUser(url, a);
  }
  const parent = normPath(b.parent);
  if ((await kindOf(parent)) !== 'dir') throw new Error(`Folder not found: ${parent}`);
  const name = String(b.name || '').trim() || repoNameOf(url);
  if (!/^(?![.-])[^/\\:\0]{1,120}$/.test(name)) throw new Error('Enter a folder name — no slashes, not starting with . or -.');
  const dir = join(parent, name);
  const k = await kindOf(dir);
  if (k !== 'missing' && (k !== 'dir' || (await readdir(dir)).length)) throw new Error(`${dir} already exists and is not empty.`);
  if ([...cloneJobs.values()].some((j) => !j.done && j.dir === dir)) throw new Error(`Already cloning into ${dir}.`);
  cloneDir = parent;
  await saveConf();

  const args = ['clone', '--progress', '--', url, dir];
  const job = { id: 'k' + Date.now().toString(36), dir, cmd: hideCred(cmdText(args)), done: false, ok: false, progress: 'Starting…', error: '' };
  cloneJobs.set(job.id, job);
  let log = '';
  const child = spawn('git', ['-c', 'core.quotepath=false', ...args], { cwd: parent, env: GIT_ENV, windowsHide: true });
  const kill = setTimeout(() => child.kill('SIGKILL'), 60 * 60 * 1000);
  child.stderr.on('data', (d) => {
    log = (log + d).slice(-8000);
    job.progress = hideCred(log.split(/[\r\n]+/).filter(Boolean).pop() || job.progress);
  });
  child.stdout.resume();
  let settled = false;
  const finish = async (ok, why) => {
    if (settled) return;
    settled = true;
    clearTimeout(kill);
    if (ok) {
      const g = gitGroups.find((x) => dir.startsWith(x.path + sep));
      if (g) { if (!g.repos.includes(dir)) g.repos.push(dir); }
      else if (!gitExtra.includes(dir)) gitExtra.push(dir);
      await saveConf();
      gitReposP = null;
    } else {
      let err = hideCred(why || log.split(/[\r\n]+/).filter((l) => l && !/^(Cloning into|remote: (Counting|Compressing|Enumerating|Total)|Receiving|Resolving)/.test(l)).join('\n').trim()) || 'git clone failed.';
      if (/Host key verification failed/.test(err)) err += `\nConnect once from a terminal (ssh -T ${url.match(/@([\w.-]+)/)?.[1] || 'host'}) to trust the host, then try again.`;
      else if (/terminal prompts disabled|Authentication failed|could not read Username/i.test(err)) err += '\nSign in to this host under Settings → Accounts, or use an SSH URL.';
      job.error = err;
    }
    gitHistory = [{ t: Date.now(), repo: name, wt: '', title: 'Clone', ok, steps: [{ cmd: job.cmd, code: ok ? 0 : 1, out: ok ? '' : job.error }] }, ...gitHistory].slice(0, GIT_HISTORY_MAX);
    Object.assign(job, { ok, done: true, progress: ok ? 'Done' : job.progress });
    setTimeout(() => cloneJobs.delete(job.id), 10 * 60 * 1000);
  };
  child.on('error', (e) => finish(false, e.message));
  child.on('close', (code) => finish(code === 0));
  return job;
}

// ─── Nhóm project ───
// PO thêm một thư mục: server quét mọi repo bên trong, PO đặt tên nhóm. Danh sách repo chụp
// lúc thêm (PO bấm Rescan khi clone thêm) — không quét lại mỗi lần tải danh sách. Chỉ đọc
// thư mục, không chạy lệnh ghi nào; fetch do trang gọi op `fetch` từng repo như Fetch all.
const SCAN_DEPTH = 4, SCAN_MAX_DIRS = 4000, SCAN_MAX_REPOS = 200;
const SCAN_SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'Pods', 'tmp']);

// Repo = thư mục có `.git` là thư mục. `.git` là tệp thì là worktree hoặc submodule — thuộc
// repo cha, không tính riêng. Vẫn đi vào trong repo: repo con có thể nằm ở thư mục bị
// .gitignore. Theo symlink nhưng mỗi thư mục
// thật chỉ đi một lần, nên vòng symlink không treo.
async function scanRepos(P) {
  const found = [], seen = new Set(), queue = [[P, 0]];
  let visited = 0, truncated = false;
  while (queue.length) {
    const [dir, depth] = queue.shift();
    let real;
    try { real = await realpath(dir); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    if (++visited > SCAN_MAX_DIRS) { truncated = true; break; }
    try {
      if ((await stat(join(dir, '.git'))).isDirectory()) {
        found.push(dir);
        if (found.length >= SCAN_MAX_REPOS) { truncated = true; break; }
      }
    } catch {}
    if (depth >= SCAN_DEPTH) continue;
    let ents = [];
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (d.name.startsWith('.') || SCAN_SKIP.has(d.name)) continue;
      const c = join(dir, d.name);
      if (d.isDirectory() || (d.isSymbolicLink() && (await kindOf(c)) === 'dir')) queue.push([c, depth + 1]);
    }
  }
  return { repos: found.sort((a, b) => a.localeCompare(b)), truncated };
}

async function groupPath(raw) {
  if (!String(raw ?? '').trim()) throw new Error('Enter a folder path.');
  let P;
  try { P = normPath(raw); } catch { throw new Error('Use an absolute path — start with / or ~/.'); }
  if (P.length > 1) P = P.replace(/\/+$/, '');
  if (P === '/') throw new Error('Pick a folder below / — scanning the whole disk is not useful.');
  if ((await kindOf(P)) !== 'dir') throw new Error(`Folder not found: ${P}`);
  return P;
}

function groupsView() {
  return { groups: gitGroups.map((g) => ({ id: g.id, name: g.name, path: g.path, addedAt: g.addedAt, repos: g.repos.length, missing: !existsSync(g.path) })) };
}

// Xem trước: repo tìm thấy + repo nào đã có trong danh sách (không thêm lần nữa).
async function gitGroupScan(body) {
  const P = await groupPath(body.path);
  const { repos, truncated } = await scanRepos(P);
  const listed = new Map();
  for (const r of await gitRepos()) {
    const g = r.group && gitGroups.find((x) => x.id === r.group);
    listed.set(r.real, g ? g.name : 'Other repositories');
  }
  const out = await Promise.all(repos.map(async (dir) => {
    let real = dir;
    try { real = await realpath(dir); } catch {}
    return { dir, rel: dir === P ? '.' : dir.slice(P.length + 1), label: basename(dir), branch: await gitBranch(dir), listed: listed.get(real) || null };
  }));
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  const dup = gitGroups.find((g) => g.path === P);
  return { path: P, name: basename(P), repos: out, truncated, limit: { depth: SCAN_DEPTH, repos: SCAN_MAX_REPOS }, already: dup ? dup.name : null };
}

function groupName(v, id) {
  const n = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!n) throw new Error('Enter a project name.');
  if (n.length > 60) throw new Error('The project name is too long (60 characters max).');
  const twin = gitGroups.find((g) => g.id !== id && g.name.toLowerCase() === n.toLowerCase());
  if (twin) throw new Error(`A project named “${twin.name}” already exists.`);
  return n;
}

// Thêm (path + name), đổi tên (id + name), quét lại (id + rescan), gỡ khỏi danh sách (id +
// remove), gỡ một repo khỏi project (id + drop: thư mục repo; quét lại thì nó quay về).
// Không xoá gì trên đĩa.
async function gitGroupOp(body) {
  let g = null;
  if (body.id) {
    g = gitGroups.find((x) => x.id === body.id);
    if (!g) throw new Error('This project is no longer in the list — refresh the page.');
    if (body.remove) gitGroups = gitGroups.filter((x) => x !== g);
    else if (body.drop) {
      if (!g.repos.includes(body.drop)) throw new Error('This repository is no longer in the project — refresh the page.');
      g.repos = g.repos.filter((d) => d !== body.drop);
    } else if (body.rescan) {
      if ((await kindOf(g.path)) !== 'dir') throw new Error(`Folder not found: ${g.path}`);
      g.repos = (await scanRepos(g.path)).repos;
    } else g.name = groupName(body.name, g.id);
  } else {
    const P = await groupPath(body.path);
    const dup = gitGroups.find((x) => x.path === P);
    if (dup) throw new Error(`This folder is already in the list as “${dup.name}”.`);
    const name = groupName(body.name);
    const { repos } = await scanRepos(P);
    if (!repos.length) throw new Error('No git repositories found in this folder.');
    g = { id: 'p' + Date.now().toString(36), name, path: P, repos, addedAt: Date.now() };
    gitGroups.push(g);
  }
  await saveConf();
  const list = await gitList(true);
  return { ...groupsView(), list, id: body.remove ? null : g.id };
}

// ─── Tổng quan các project (dashboard) ───
// Một lần đọc cho cả trang tổng quan: trạng thái từng repo, commit gần nhất, lần fetch gần
// nhất và từng worktree. Chỉ đọc. ↑↓ so với bản remote ở lần fetch gần nhất — trang ghi rõ.
// Giới hạn số lệnh git chạy cùng lúc: dự án thật có cả trăm worktree.
async function inPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (let k; (k = i++) < items.length;) out[k] = await fn(items[k]);
  }));
  return out;
}
const slimStatus = (s) => (s.error ? { error: s.error } : {
  branch: s.branch, detached: s.detached, upstream: s.upstream, ahead: s.ahead, behind: s.behind,
  tracked: s.tracked, untracked: s.untracked, conflicts: s.conflicts, op: s.op, files: s.filesTotal,
});
async function lastCommit(dir) {
  const r = await git(dir, ['log', '-1', '--format=%ct%x09%an%x09%s'], 5000);
  if (!r.ok || !r.out.trim()) return null;
  const [when, author, ...s] = r.out.trim().split('\t');
  return { when: +when, author, subject: s.join('\t') };
}
async function gitOverview() {
  const repos = await gitRepos();
  const rows = await inPool(repos, 6, async (r) => {
    const [s, wts, fetched, remotes, last] = await Promise.all([
      gitStatus(r.dir, 'normal', 0), worktreesOf(r.dir), fetchedAt(r.dir), gitRemotes(r.dir), lastCommit(r.dir)]);
    const wtRows = await inPool(wts.extra, 4, async (w) => {
      const [ws, wl] = await Promise.all([gitStatus(w.path, 'normal', 0), lastCommit(w.path)]);
      return { rel: w.rel, branch: w.branch, detached: w.detached, locked: !!w.locked, created: w.created, status: slimStatus(ws), last: wl };
    });
    return {
      id: r.id, label: r.label, dir: r.dir, group: r.group || null, extra: !!r.extra, readOnly: r.readOnly || null,
      status: slimStatus(s), fetchedAt: fetched, remotes: remotes.length, last, created: wts.main?.created || 0, worktrees: wtRows,
    };
  });
  return { at: Date.now(), ...groupsView(), repos: rows };
}

// ─── Xem tệp dạng web: /git-view/<repo>/<wt|~>/<work|index|sha>/<đường dẫn> ───
// Đường dẫn tệp nằm trên URL nên link tương đối trong trang (ảnh, css, trang khác) tự tìm
// đúng tệp cạnh nó, cùng phiên bản. Mọi phản hồi mang CSP sandbox (origin rỗng): script
// trong tệp vẫn chạy nhưng không gọi được API của server này (POST cần X-Dev-Runner).
const VIEW_TYPES = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', map: 'application/json', txt: 'text/plain', md: 'text/plain', csv: 'text/plain',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  ico: 'image/x-icon', pdf: 'application/pdf', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
};
const VIEW_MAX = 30 * 1024 * 1024;
const VIEW_CSP = 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads';

function viewFail(res, code, msg) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': VIEW_CSP });
  res.end(msg);
}

function gitBlob(cwd, spec) {
  return new Promise((done) => execFile('git', ['-C', cwd, 'cat-file', 'blob', spec],
    { timeout: 15000, killSignal: 'SIGKILL', env: GIT_ENV, encoding: 'buffer', maxBuffer: VIEW_MAX }, (e, so) => done(e ? null : so)));
}

async function gitView(res, rest) {
  const seg = rest.split('/').map((x) => decodeURIComponent(x));
  if (seg.length < 4) return viewFail(res, 404, 'Not found.');
  const [repo, wt, rev] = seg;
  const parts = seg.slice(3);
  if (parts[parts.length - 1] === '') parts[parts.length - 1] = 'index.html';
  if (parts.some((x) => !x || x === '.' || x === '..' || x === '.git' || x.includes('\0') || x.includes('\\'))) return viewFail(res, 400, 'Invalid path.');
  const path = parts.join('/');
  if (isSecret(path)) return viewFail(res, 403, 'Secret file (.env, key, certificate…) — not shown here.');
  const { dir } = await gitTarget({ repo, wt: wt === '~' ? '' : wt });
  let buf = null;
  if (rev === 'work') {
    // Tệp trên đĩa. Symlink trỏ ra ngoài repo, vào .git hay vào tệp bí mật thì không đọc.
    const root = await realpath(dir);
    const real = await realpath(join(root, path)).catch(() => null);
    const rel = real && real.startsWith(root + sep) ? real.slice(root.length + 1) : null;
    if (rel && !rel.split(sep).includes('.git') && !isSecret(rel)) {
      const st = await stat(real);
      if (st.isFile() && st.size <= VIEW_MAX) buf = await readFile(real);
    }
  } else if (rev === 'index' || SHA_RE.test(rev)) {
    buf = await gitBlob(dir, (rev === 'index' ? '' : rev) + ':' + path);
  } else return viewFail(res, 400, 'Unknown version.');
  if (!buf) return viewFail(res, 404, `${path} — not found in this version.`);
  const type = VIEW_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] || 'text/plain';
  const text = /^text\/|json|svg/.test(type);
  res.writeHead(200, { 'content-type': type + (text ? '; charset=utf-8' : ''), 'cache-control': 'no-store',
    'content-security-policy': VIEW_CSP, 'x-content-type-options': 'nosniff' });
  res.end(buf);
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, max = 200000) {
  return new Promise((done, fail) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > max) { fail(new Error('Request body too large.')); req.destroy(); } });
    req.on('end', () => { try { done(s ? JSON.parse(s) : {}); } catch (e) { fail(e); } });
    req.on('error', fail);
  });
}

// xterm cho khay Terminal của tab Git (chỉ hiện trong GitMenorah — shell chạy ở app, không ở
// server này). Lúc chạy từ mã nguồn gói nằm ở git-desktop/node_modules; bản đóng gói chép
// git-server vào server/tools/ còn gói ở node_modules của app (build-git.sh). Chỉ .js/.css.
const XTERM_DIR = [join(TOOLS, 'git-desktop', 'node_modules', '@xterm'), resolve(TOOLS, '..', '..', 'node_modules', '@xterm')]
  .find((d) => existsSync(join(d, 'xterm', 'lib', 'xterm.js')));
// Bộ gõ tiếng Việt của terminal nằm ở app/vnkey.js của GitMenorah (cùng chỗ với gói xterm).
const VNKEY = [join(TOOLS, 'git-desktop', 'app', 'vnkey.js'), resolve(TOOLS, '..', '..', 'app', 'vnkey.js')].find(existsSync);
const VENDOR_RE = /^\/vendor\/(xterm|addon-fit|addon-unicode11|addon-web-links|vnkey)\/((?:lib|css)\/[\w.-]+\.(js|css)|vnkey\.js)$/;
// Monaco (trình soạn tệp của chế độ IDE): chỉ bản min/vs của gói monaco-editor, cùng chỗ với xterm.
const MONACO_DIR = [join(TOOLS, 'git-desktop', 'node_modules', 'monaco-editor', 'min'), resolve(TOOLS, '..', '..', 'node_modules', 'monaco-editor', 'min')]
  .find((d) => existsSync(join(d, 'vs', 'loader.js')));
const MONACO_RE = /^\/vendor\/monaco\/(vs(?:\/[\w-]+(?:\.[\w-]+)*)+\.(js|css|ttf))$/;
const VENDOR_TYPES = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', ttf: 'font/ttf' };
async function serveVendor(res, m) {
  const file = m[1] === 'vnkey' ? m[2] === 'vnkey.js' && VNKEY : XTERM_DIR && join(XTERM_DIR, m[1], m[2]);
  if (!file || !existsSync(file)) return json(res, 404, { error: 'xterm package not found.' });
  res.writeHead(200, { 'content-type': VENDOR_TYPES[m[3]], 'cache-control': 'max-age=3600', 'x-content-type-options': 'nosniff' });
  return res.end(await readFile(file));
}
async function serveMonaco(res, m) {
  const file = MONACO_DIR && join(MONACO_DIR, m[1]);
  if (!file || !existsSync(file)) return json(res, 404, { error: 'monaco-editor package not found.' });
  res.writeHead(200, { 'content-type': VENDOR_TYPES[m[2]], 'cache-control': 'max-age=86400', 'x-content-type-options': 'nosniff' });
  return res.end(await readFile(file));
}

// Routes of the Git page. Returns false when the request is not one of them, so a host
// server can try its own routes next. The caller checks Host and the X-Dev-Runner header.
export async function gitRoute(req, res, url) {
  const get = req.method === 'GET', post = req.method === 'POST', p = url.pathname;
  if (get && (p === '/' || p === '/git.html')) {
    const html = await readFile(PAGE);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return true;
  }
  const vendor = get && p.match(VENDOR_RE);
  if (vendor) { await serveVendor(res, vendor); return true; }
  const mon = get && p.match(MONACO_RE);
  if (mon) { await serveMonaco(res, mon); return true; }
  if (get && p.startsWith('/git-view/')) { await gitView(res, p.slice(10)); return true; }
  if (!p.startsWith('/api/git/')) return false;
  const qp = Object.fromEntries(url.searchParams);
  const out = (body) => { json(res, 200, body); return true; };
  if (get && p === '/api/git/repos') return out(await gitList(url.searchParams.has('refresh')));
  if (get && p === '/api/git/detail') return out(await gitDetail({ repo: qp.repo, wt: qp.wt || '' }));
  if (get && p === '/api/git/history') return out(gitHistory);
  if (get && p === '/api/git/progress') {
    const r = (await gitRepos()).find((x) => x.id === qp.repo);
    return out({ running: (r && gitRunning.get(r.real)) || null });
  }
  if (get && p === '/api/git/graph') return out(await gitGraph(qp));
  if (get && p === '/api/git/commit') return out(await gitCommitInfo(qp));
  if (get && p === '/api/git/diff') return out(await gitDiff({ ...qp, staged: qp.staged === '1' }));
  if (get && p === '/api/git/files') return out(await gitFiles(qp));
  if (get && p === '/api/git/file') return out(await gitFile(qp));
  if (get && p === '/api/git/file-log') return out(await gitFileLog(qp));
  if (get && p === '/api/git/groups') return out(groupsView());
  if (get && p === '/api/git/overview') return out(await gitOverview());
  if (post && p === '/api/git/run') return out(await gitRun(await readBody(req)));
  if (post && p === '/api/git/save') return out(await gitSave(await readBody(req, FILE_MAX * 3)));
  if (post && p === '/api/git/identity') return out(await gitSetIdentity(await readBody(req)));
  if (post && p === '/api/git/suggest-message') return out(await gitSuggestMessage(await readBody(req)));
  if (post && p === '/api/git/extra') return out(await gitAddExtra(await readBody(req)));
  if (post && p === '/api/git/groups/scan') return out(await gitGroupScan(await readBody(req)));
  if (post && p === '/api/git/groups') return out(await gitGroupOp(await readBody(req)));
  if (get && p === '/api/git/accounts') return out(await accountsView());
  if (post && p === '/api/git/accounts') return out(await gitAccountOp(await readBody(req)));
  if (get && p === '/api/git/clone') {
    const j = cloneJobs.get(qp.job);
    if (!j) throw new Error('No such clone.');
    return out(j);
  }
  if (post && p === '/api/git/clone') return out(await gitClone(await readBody(req)));
  if (post && p === '/api/git/pick') {
    const prompt = (await readBody(req)).repo ? 'Choose a git repository' : 'Choose a folder that contains git repositories';
    return out(await pickFolder({ prompt }));
  }
  return false;
}

// ─── Standalone server ─────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const PORT = Number((argv.find((a) => a.startsWith('--port=')) || '--port=4990').split('=')[1]);
  const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  const server = createServer(async (req, res) => {
    if (!HOSTS.has(req.headers.host)) return json(res, 403, { error: 'Host not allowed.' });
    if (req.method === 'POST' && !req.headers['x-dev-runner']) return json(res, 403, { error: 'Missing X-Dev-Runner header.' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (!(await gitRoute(req, res, url))) json(res, 404, { error: 'No such route.' });
    } catch (e) {
      if (res.headersSent) res.destroy(); else json(res, 400, { error: e.message });
    }
  });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use — run with --port=<another>.` : e.message);
    process.exit(1);
  });
  await loadGitConf();
  server.listen(PORT, '127.0.0.1', () => {
    const link = `http://127.0.0.1:${PORT}`;
    // The desktop app waits for this line (it looks for "127.0.0.1:<port>").
    console.log(`git.html → ${link}`);
    if (argv.includes('--open') && process.platform === 'darwin') execFile('open', [link]);
  });
}

// Run the server only when this file is the entry point (not when a host server imports it).
const entry = process.argv[1] && await realpath(process.argv[1]).catch(() => null);
if (entry && fileURLToPath(import.meta.url) === entry) await main();
