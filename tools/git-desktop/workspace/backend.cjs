// Workspace của GitMenorah — phần chạy ở tiến trình chính.
//
// Học theo concept của nodeterm: mỗi project (một thư mục) có một canvas, trên đó là các node
// terminal chạy agent (Claude Code, Codex) hoặc shell, ghi chú và ảnh. Hai node nối dây thì
// agent ở node này đọc được ngữ cảnh của node kia khi cần (kéo, không đẩy).
//
// Tệp này lo:
//   - project + canvas: lưu ở userData/workspace/, KHÔNG ghi gì vào repo
//   - nối với menorah-agentd (Go, agentd/ + agentd.cjs): PTY, giới hạn CPU / RAM, transcript
//     Claude / Codex, sub agent, tai thỏ và cổng `menorah-context` đều chạy ở đó. Phiên sống ở
//     agentd — đổi tab, tải lại trang hay đóng cửa sổ (macOS) không làm chết agent; mở lại thì
//     gắn vào bộ đệm cũ. Ở đây chỉ nhớ phiên nào đang sống và cửa sổ nào đang xem
//   - Agents: gom node theo repo → worktree bằng git
//
// Renderer chỉ nói chuyện qua ipc `ws:*` (xem preload.cjs); handler từ chối frame khác trang app.

const { ipcMain, BrowserWindow, dialog, shell, clipboard, nativeImage, screen, systemPreferences } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAgentd } = require('./agentd.cjs');

const APP_ORIGIN = 'menorah://app';
const HOME = os.homedir();

let dirs = null;                     // { root, canvas, uploads, bin }
const sessions = new Map();          // nodeId → { viewers: Set<webContents.id>, sessionId } — phiên đang sống ở agentd
const canvases = new Map();          // canvasId → doc canvas (bản mới nhất renderer gửi)
const owners = new Map();            // projectId → webContents.id đang mở
let agentd = null;                   // tiến trình menorah-agentd (agentd.cjs)

// ─── Tiện ích ──────────────────────────────────────────────────────────────
const uid = (p) => `${p}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

function run(cmd, args, opts = {}) {
  return new Promise((done) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 8 << 20, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      done({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() });
    });
  });
}

// ─── Project + canvas ──────────────────────────────────────────────────────
const projectsFile = () => path.join(dirs.root, 'projects.json');
const canvasFile = (id) => path.join(dirs.canvas, `${id.replace(/[^\w.-]/g, '_')}.json`);

// Mỗi project có nhiều canvas: { canvases: [{ id, name }], canvasId }. Bản cũ chỉ có một canvas
// lưu ở canvas/<projectId>.json — giữ tệp đó làm "Canvas 1".
function loadProjects() {
  const st = readJson(projectsFile(), { projects: [], lastId: null });
  for (const p of st.projects) {
    if (!Array.isArray(p.canvases) || !p.canvases.length) p.canvases = [{ id: p.id, name: 'Canvas 1' }];
    if (!p.canvases.some((c) => c.id === p.canvasId)) p.canvasId = p.canvases[0].id;
  }
  return st;
}
function updateProject(id, fn) {
  const st = loadProjects();
  const p = st.projects.find((x) => x.id === id);
  if (!p) throw new Error('Project not found');
  const r = fn(p, st);
  writeJson(projectsFile(), st);
  return r === undefined ? p : r;
}

function addProject(dir) {
  const st = loadProjects();
  const cwd = path.resolve(dir);
  let p = st.projects.find((x) => x.cwd === cwd);
  if (!p) {
    p = { id: uid('p'), name: path.basename(cwd), cwd, createdAt: Date.now() };
    p.canvases = [{ id: p.id, name: 'Canvas 1' }];
    p.canvasId = p.id;
    st.projects.push(p);
  }
  st.lastId = p.id;
  writeJson(projectsFile(), st);
  return p;
}

function emptyCanvas() { return { version: 1, viewport: { x: 80, y: 80, zoom: 1 }, nodes: [], links: [] }; }

function getCanvas(canvasId) {
  if (!canvases.has(canvasId)) canvases.set(canvasId, readJson(canvasFile(canvasId), emptyCanvas()));
  return canvases.get(canvasId);
}

function allNodes() {
  const out = [];
  for (const p of loadProjects().projects) {
    for (const c of p.canvases) for (const n of getCanvas(c.id).nodes || []) out.push({ project: p, canvas: c, node: n });
  }
  return out;
}

// ─── PTY (ở agentd) ────────────────────────────────────────────────────────
// Phiên PTY sống ở menorah-agentd; ở đây chỉ nhớ phiên nào đang sống và cửa sổ nào đang xem để
// chuyển output tới đúng nơi.
function broadcast(s, channel, payload) {
  for (const id of s.viewers) {
    const wc = require('electron').webContents.fromId(id);
    if (wc && !wc.isDestroyed()) wc.send(channel, payload); else s.viewers.delete(id);
  }
}

function onAgentdEvent(m) {
  const s = sessions.get(m.nodeId);
  if (m.ev === 'data') { if (s) broadcast(s, 'ws:pty-data', { nodeId: m.nodeId, data: m.data }); }
  else if (m.ev === 'exit') {
    if (s) { sessions.delete(m.nodeId); broadcast(s, 'ws:pty-exit', { nodeId: m.nodeId, code: m.code }); }
  } else if (m.ev === 'session') {
    if (s) { s.sessionId = m.sessionId; broadcast(s, 'ws:pty-session', { nodeId: m.nodeId, sessionId: m.sessionId }); }
  } else if (m.ev === 'alert') {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('ws:limit-alert', m.msg);
  }
}

// agentd chết thì mọi phiên chết theo: báo thoát cho cửa sổ đang xem, khỏi treo "Đang chạy".
function onAgentdCrash() {
  for (const [nodeId, s] of sessions) broadcast(s, 'ws:pty-exit', { nodeId, code: -1 });
  sessions.clear();
}

async function startSession(opts, sender) {
  const r = await agentd.call('pty-start', {
    nodeId: String(opts.nodeId || ''), agent: opts.agent || 'shell', cwd: typeof opts.cwd === 'string' ? opts.cwd : '',
    sessionId: opts.sessionId || '', cols: opts.cols | 0, rows: opts.rows | 0,
  });
  let s = sessions.get(opts.nodeId);
  if (!s) { s = { viewers: new Set(), sessionId: r.sessionId }; sessions.set(opts.nodeId, s); }
  s.viewers.add(sender.id);
  return { buffer: r.buffer, sessionId: r.sessionId, attached: r.attached };
}

async function statusOf(ids) {
  if (!ids.length) return {};
  try { return await agentd.call('status', ids); } catch { return Object.fromEntries(ids.map((id) => [id, 'stopped'])); }
}

const killNodes = (ids) => { if (ids.length) agentd.send('pty-kill', { nodeIds: ids }); };

// ─── Tệp thả vào ───────────────────────────────────────────────────────────
// Ảnh kéo từ ô xem trước của macOS nằm ở TemporaryItems và bị xoá ngay sau đó — chép sang
// uploads/ để agent đọc kịp. Ảnh không có đường dẫn (dán từ clipboard) ghi thẳng vào uploads/.
function stamp() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }

function stashPath(p) {
  if (!p || !/[\\/](TemporaryItems|NSIRD_screencaptureui)[^\\/]*[\\/]/.test(p) && !p.includes(`${path.sep}T${path.sep}`)) return p;
  try {
    fs.mkdirSync(dirs.uploads, { recursive: true });
    const dest = path.join(dirs.uploads, `${stamp()}-${path.basename(p).replace(/\s+/g, '-')}`);
    fs.copyFileSync(p, dest);
    return dest;
  } catch { return p; }
}

function saveBytes(bytes, name) {
  fs.mkdirSync(dirs.uploads, { recursive: true });
  const ext = (path.extname(name || '') || '.png').toLowerCase().replace(/[^.\w]/g, '');
  const base = path.basename(name || 'image', path.extname(name || '')).replace(/[^\w.-]+/g, '-').slice(0, 40) || 'image';
  const dest = path.join(dirs.uploads, `${stamp()}-${base}${ext}`);
  fs.writeFileSync(dest, Buffer.from(bytes));
  return dest;
}

// Ảnh chụp màn hình gần đây: macOS đọc vị trí lưu của screencapture (mặc định Desktop).
let shotDir = null;
async function screenshotDir() {
  if (shotDir) return shotDir;
  if (process.platform === 'darwin') {
    const r = await run('defaults', ['read', 'com.apple.screencapture', 'location']);
    const d = r.ok && r.out ? r.out.replace(/^~/, HOME) : path.join(HOME, 'Desktop');
    shotDir = fs.existsSync(d) ? d : path.join(HOME, 'Desktop');
  } else {
    shotDir = [path.join(HOME, 'Pictures', 'Screenshots'), path.join(HOME, 'OneDrive', 'Pictures', 'Screenshots')].find(fs.existsSync) || path.join(HOME, 'Pictures');
  }
  return shotDir;
}

async function recentShots() {
  const out = [];
  for (const dir of [await screenshotDir(), dirs.uploads]) {
    let names = [];
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const n of names) {
      if (!/\.(png|jpe?g|gif|webp)$/i.test(n)) continue;
      if (dir !== dirs.uploads && !/^(Screenshot|Screen Shot|Ảnh màn hình|Bildschirmfoto|Capture|Snip)/i.test(n)) continue;
      try { const st = await fsp.stat(path.join(dir, n)); out.push({ path: path.join(dir, n), name: n, mtime: st.mtimeMs }); } catch {}
    }
  }
  return out.filter((x) => Date.now() - x.mtime < 3 * 864e5).sort((a, b) => b.mtime - a.mtime).slice(0, 12);
}

// ─── Danh sách agent ───────────────────────────────────────────────────────
// Phẳng, không gọi git: tab Agents trong cột trái Git tự xếp agent vào worktree theo cwd
// (nó đã có sẵn danh sách worktree của repo đang xem).
async function agentList() {
  const list = allNodes().filter((x) => x.node.kind === 'terminal');
  const info = await agentd.call('agents', list.map(({ node }) => ({ nodeId: node.id, agent: node.agent, sessionId: node.sessionId || '' })));
  return list.map(({ project, canvas, node }) => ({
    nodeId: node.id, projectId: project.id, projectName: project.name, canvasId: canvas.id, canvasName: canvas.name,
    title: node.title, agent: node.agent, cwd: path.resolve(node.cwd || project.cwd),
    status: info[node.id]?.status || 'stopped', last: info[node.id]?.last || '', subs: info[node.id]?.subs || 0,
  }));
}

// ─── Tai thỏ (notch) ───────────────────────────────────────────────────────
// Mỗi phiên agent đang mở: tin gần nhất của người dùng, model, % context (agentd đọc transcript).
async function notchList() {
  const list = allNodes().filter((x) => x.node.kind === 'terminal' && x.node.agent !== 'shell' && sessions.has(x.node.id));
  if (!list.length) return [];
  const info = await agentd.call('notch', list.map(({ node }) => ({ nodeId: node.id, agent: node.agent, sessionId: node.sessionId || '' })));
  const out = [];
  for (const { project, canvas, node } of list) {
    const x = info[node.id];
    if (!x) continue;
    out.push({
      nodeId: node.id, projectId: project.id, projectName: project.name, canvasId: canvas.id, canvasName: canvas.name,
      title: node.title, agent: node.agent, status: x.status, startedAt: x.startedAt, ...x.tail, subs: x.subs,
    });
  }
  const rank = (a) => (a.status === 'running' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || (b.lastAt || b.startedAt) - (a.lastAt || a.startedAt));
}

// Số node terminal và số phiên đang chạy theo từng canvas của một project (badge ở dải tab).
async function canvasStats(projectId) {
  const p = loadProjects().projects.find((x) => x.id === projectId);
  const byCanvas = (p?.canvases || []).map((c) => [c.id, (getCanvas(c.id).nodes || []).filter((n) => n.kind === 'terminal').map((n) => n.id)]);
  const st = await statusOf(byCanvas.flatMap(([, ids]) => ids));
  const out = {};
  for (const [id, ids] of byCanvas) {
    out[id] = { total: ids.length, running: ids.filter((x) => st[x] === 'running').length, live: ids.filter((x) => sessions.has(x)).length };
  }
  return out;
}

// Sơ đồ nối dây cho cổng menorah-context (ở agentd): node nào nối với node nào, ghi chú, ảnh.
function pushCanvas(canvasId) {
  const doc = getCanvas(canvasId);
  agentd.send('canvas', {
    canvasId,
    nodes: (doc.nodes || []).map((n) => ({ id: n.id, kind: n.kind, agent: n.agent || '', title: n.title || '', text: n.text || '', path: n.path || '', cwd: n.cwd || '', sessionId: n.sessionId || '' })),
    links: (doc.links || []).map((l) => ({ from: l.from, to: l.to })),
  });
}
function pushAllCanvases() {
  for (const p of loadProjects().projects) for (const c of p.canvases) pushCanvas(c.id);
}

// Lệnh `menorah-context` đặt ở userData/bin (đã có trong PATH của terminal) + skill cho
// Claude Code và Codex để agent biết mà dùng. Ghi lại mỗi lần mở app nếu nội dung đổi.
function writeIfChanged(file, content, mode) {
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, mode ? { mode } : undefined);
    if (mode) fs.chmodSync(file, mode);
  } catch {}
}

function installCli() {
  const sh = `#!/bin/sh
# menorah-context — read the context of nodes linked on the GitMenorah canvas.
#   menorah-context list | summary [--node X] [-n 15] | transcript [--node X] | terminal [--node X]
if [ -z "$MENORAH_CTX_URL" ] || [ -z "$MENORAH_NODE_ID" ]; then
  echo "Not a GitMenorah session (MENORAH_CTX_URL / MENORAH_NODE_ID missing)." >&2; exit 2
fi
exec curl -sS -G -H "x-menorah-token: $MENORAH_CTX_TOKEN" \\
  --data-urlencode "self=$MENORAH_NODE_ID" --data-urlencode "args=$*" "$MENORAH_CTX_URL/ctx"
`;
  const cmd = `@echo off\r
rem menorah-context — read the context of nodes linked on the GitMenorah canvas.\r
if "%MENORAH_CTX_URL%"=="" ( echo Not a GitMenorah session. 1>&2 & exit /b 2 )\r
curl.exe -sS -G -H "x-menorah-token: %MENORAH_CTX_TOKEN%" --data-urlencode "self=%MENORAH_NODE_ID%" --data-urlencode "args=%*" "%MENORAH_CTX_URL%/ctx"\r
`;
  writeIfChanged(path.join(dirs.bin, 'menorah-context'), sh, 0o755);
  writeIfChanged(path.join(dirs.bin, 'menorah-context.cmd'), cmd);

  const skill = `---
name: menorah-linked-context
description: Read the conversation, a recent summary, or the terminal output of another agent node (Claude, Codex, terminal) or a sticky note that this session is linked to on the GitMenorah canvas. Use when the user says "read the context of node …", "what is the other node doing" (in any language), asks you to continue / hand off / review another node's work, or refers to a linked note. Only works when the environment has MENORAH_NODE_ID.
---

# Linked context on the GitMenorah canvas

This terminal runs inside GitMenorah. The user can link nodes on the canvas with a rope; a linked
node's context is NOT pushed to you — pull it on demand with:

\`\`\`sh
menorah-context list                          # nodes linked to you: id, kind, title
menorah-context summary [--node X] [-n 15]    # last N messages of a linked agent
menorah-context transcript [--node X]         # its full conversation (user / agent / tool lines)
menorah-context terminal [--node X]           # recent terminal output, ANSI stripped (approximate for TUIs)
\`\`\`

If \`menorah-context\` is not on PATH, run it by absolute path: \`${path.join(dirs.bin, 'menorah-context')}\`.

- Start with \`list\`. \`--node\` takes an id or a title (exact, then substring); it is optional when exactly one node is linked.
- Linked sticky notes appear as kind \`note\`; \`summary\` on a note prints its current text.
- Prefer \`summary\` first, then \`transcript\` only if you need detail — transcripts can be long.
- "Not a GitMenorah session" or "Not linked to any node" means there is nothing to read — do not retry.
- Codex sandbox: the command calls 127.0.0.1 with curl. If the sandbox blocks network, ask for an escalated run of the same command.
`;
  for (const base of [path.join(HOME, '.claude'), process.env.CODEX_HOME || path.join(HOME, '.codex')]) {
    if (fs.existsSync(base)) writeIfChanged(path.join(base, 'skills', 'menorah-linked-context', 'SKILL.md'), skill);
  }
}

// ─── IPC ───────────────────────────────────────────────────────────────────
function fromApp(e) {
  // URL của scheme riêng có origin "null" với new URL() — so tiền tố thay vì origin.
  const f = e.senderFrame;
  return !!f && !f.parent && f.url.startsWith(`${APP_ORIGIN}/`);
}
function handle(ch, fn) {
  ipcMain.handle(ch, async (e, ...a) => { if (!fromApp(e)) throw new Error('forbidden'); return fn(e, ...a); });
}
function on(ch, fn) {
  ipcMain.on(ch, (e, ...a) => { if (fromApp(e)) fn(e, ...a); });
}

// settings: { load, save } — userData/settings.json của main.cjs; giới hạn lưu ở khoá `limits`.
async function setup({ app, gitOrigin, settings }) {
  dirs = {
    root: path.join(app.getPath('userData'), 'workspace'),
    canvas: path.join(app.getPath('userData'), 'workspace', 'canvas'),
    uploads: path.join(app.getPath('userData'), 'workspace', 'uploads'),
    bin: path.join(app.getPath('userData'), 'bin'),
  };
  fs.mkdirSync(dirs.canvas, { recursive: true });

  // menorah-agentd: chạy lại sau crash thì nạp lại thư mục bin, giới hạn và sơ đồ canvas.
  const cleanLimits = (x) => ({ cpu: Math.max(0, +x?.cpu || 0), ramMb: Math.max(0, +x?.ramMb || 0) });
  let agentdError = null;
  const prime = () => {
    agentd.send('init', { binDir: dirs.bin });
    agentd.send('limits-set', cleanLimits(settings?.load().limits));
    pushAllCanvases();
  };
  let up = false;
  agentd = createAgentd({ onEvent: onAgentdEvent, onCrash: onAgentdCrash, onReady: () => { if (up) prime(); } });
  agentd.start();
  try { await agentd.ready(); up = true; prime(); } catch (e) { agentdError = e.message; }
  installCli();

  handle('ws:info', () => ({
    gitOrigin: gitOrigin(), platform: process.platform, home: HOME, ptyError: agentdError,
    agents: { claude: true, codex: true },
  }));

  // Project
  handle('ws:projects', () => loadProjects());
  handle('ws:project-add', async (e, dir) => {
    if (!dir) {
      const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Choose a project folder', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled) return null;
      dir = r.filePaths[0];
    }
    return addProject(dir);
  });
  handle('ws:project-remove', (e, id) => {
    const st = loadProjects();
    const p = st.projects.find((x) => x.id === id);
    for (const c of p?.canvases || []) {
      killNodes((getCanvas(c.id).nodes || []).map((n) => n.id));
      agentd.send('canvas-drop', c.id);
    }
    st.projects = st.projects.filter((x) => x.id !== id);
    if (st.lastId === id) st.lastId = st.projects[0]?.id || null;
    writeJson(projectsFile(), st);
    return st;
  });
  handle('ws:project-open', (e, id) => {
    // Một project chỉ mở ở một cửa sổ: hai cửa sổ cùng ghi một canvas thì bản sau đè bản trước.
    const other = owners.get(id);
    if (other && other !== e.sender.id) {
      const wc = require('electron').webContents.fromId(other);
      const w = wc && !wc.isDestroyed() && BrowserWindow.fromWebContents(wc);
      if (w) { w.focus(); return { elsewhere: true }; }
    }
    for (const [pid, wid] of owners) if (wid === e.sender.id) owners.delete(pid);
    owners.set(id, e.sender.id);
    e.sender.once('destroyed', () => { if (owners.get(id) === e.sender.id) owners.delete(id); });
    const st = loadProjects();
    st.lastId = id;
    writeJson(projectsFile(), st);
    const p = st.projects.find((x) => x.id === id);
    return { project: p, canvas: getCanvas(p.canvasId) };
  });

  // Canvas trong project. Chỉ cửa sổ đang giữ project mới được đổi.
  const own = (e, projectId) => { if (owners.get(projectId) !== e.sender.id) throw new Error('The project is open in another window'); };
  handle('ws:canvas-open', (e, projectId, canvasId) => {
    own(e, projectId);
    const p = updateProject(projectId, (x) => { if (x.canvases.some((c) => c.id === canvasId)) x.canvasId = canvasId; });
    return { project: p, canvas: getCanvas(p.canvasId) };
  });
  // Canvas mới gắn được thư mục riêng (một repo của tab Git, hoặc thư mục chọn bằng hộp thoại):
  // agent mở trên canvas đó chạy ở thư mục ấy. Không có cwd = dùng thư mục project.
  handle('ws:canvas-add', async (e, projectId, opts = {}) => {
    own(e, projectId);
    if (typeof opts === 'string') opts = { name: opts };
    let cwd = opts.cwd ? String(opts.cwd) : null;
    if (opts.pick) {
      const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Choose a folder for the canvas', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled) return null;
      cwd = r.filePaths[0];
    }
    if (cwd) {
      cwd = path.resolve(cwd);
      if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Folder not found: ${cwd}`);
    }
    return updateProject(projectId, (x) => {
      if (cwd === x.cwd) cwd = null;
      const c = { id: uid('c'), name: String(opts.name || '').trim().slice(0, 60) || (cwd ? path.basename(cwd) : `Canvas ${x.canvases.length + 1}`), ...(cwd && { cwd }) };
      x.canvases.push(c);
      x.canvasId = c.id;
    });
  });
  handle('ws:canvas-rename', (e, projectId, canvasId, name) => {
    own(e, projectId);
    name = String(name || '').trim().slice(0, 60);
    return updateProject(projectId, (x) => { const c = x.canvases.find((y) => y.id === canvasId); if (c && name) c.name = name; });
  });
  // Xoá canvas: tắt phiên của các node trên đó, xoá tệp. Không xoá canvas cuối cùng.
  handle('ws:canvas-remove', (e, projectId, canvasId) => {
    own(e, projectId);
    return updateProject(projectId, (x) => {
      if (x.canvases.length < 2) throw new Error('A project needs at least one canvas');
      killNodes((getCanvas(canvasId).nodes || []).map((n) => n.id));
      agentd.send('canvas-drop', canvasId);
      x.canvases = x.canvases.filter((c) => c.id !== canvasId);
      if (x.canvasId === canvasId) x.canvasId = x.canvases[0].id;
      canvases.delete(canvasId);
      try { fs.unlinkSync(canvasFile(canvasId)); } catch {}
    });
  });
  handle('ws:canvas-save', (e, projectId, canvasId, doc) => {
    if (owners.get(projectId) !== e.sender.id || !doc || !Array.isArray(doc.nodes)) return false;
    if (!loadProjects().projects.find((x) => x.id === projectId)?.canvases.some((c) => c.id === canvasId)) return false;
    canvases.set(canvasId, doc);
    writeJson(canvasFile(canvasId), doc);
    pushCanvas(canvasId);
    return true;
  });

  // PTY — gửi thẳng sang agentd; ở đây chỉ giữ danh sách cửa sổ đang xem.
  handle('ws:pty-start', (e, opts) => startSession(opts || {}, e.sender));
  handle('ws:pty-state', (e, ids) => statusOf(Array.isArray(ids) ? ids : []));
  on('ws:pty-write', (e, nodeId, data) => { if (sessions.has(nodeId) && typeof data === 'string') agentd.send('pty-write', { nodeId, data }); });
  on('ws:pty-resize', (e, nodeId, cols, rows) => { if (sessions.has(nodeId) && cols > 0 && rows > 0) agentd.send('pty-resize', { nodeId, cols: cols | 0, rows: rows | 0 }); });
  handle('ws:pty-kill', (e, nodeId) => { killNodes([nodeId]); return true; });
  on('ws:pty-detach', (e, nodeId) => { sessions.get(nodeId)?.viewers.delete(e.sender.id); });

  // Sub agent của các node Claude: { nodeId: [...] }. agentd bỏ sub agent đã xong quá 15 phút.
  handle('ws:subagents', (e, list) => agentd.call('subagents', (Array.isArray(list) ? list : []).map((x) => ({ nodeId: x?.nodeId || '', sessionId: x?.sessionId || '' }))));

  // Chat
  handle('ws:chat-read', (e, { nodeId, agent, sessionId, offset }) => agentd.call('chat-read', { nodeId: nodeId || '', agent: agent || '', sessionId: sessionId || '', offset: +offset || 0 }));

  // Cửa sổ: header tab Git nằm trong iframe nên không dùng được -webkit-app-region. 'start' ghi
  // vị trí cửa sổ + con trỏ màn hình, mỗi 'move' đặt cửa sổ theo độ lệch con trỏ, 'end' thôi.
  const winDrags = new Map();
  // macOS: setPosition/zoom làm AppKit dựng lại khung titlebar cao 28px mặc định, ba nút đèn
  // (đặt ở trafficLightPosition y:16) bị cắt mép. Gán lại vị trí để Electron vẽ lại khung cho vừa.
  const keepLights = (win) => {
    if (process.platform !== 'darwin' || win.isDestroyed() || win.isFullScreen()) return;
    const at = win.getWindowButtonPosition();
    if (at) win.setWindowButtonPosition(at);
  };
  // Phóng to có hiệu ứng, khung titlebar dựng lại khi hiệu ứng xong. Gắn cho mọi cửa sổ lúc tạo,
  // gồm cả lúc nhấp đúp vào rail (zoom của macOS).
  const lightsHooked = new WeakSet();
  const hookLights = (win) => {
    if (process.platform !== 'darwin' || lightsHooked.has(win)) return;
    lightsHooked.add(win);
    for (const ev of ['maximize', 'unmaximize']) win.on(ev, () => setTimeout(() => keepLights(win), 50));
  };
  app.on('browser-window-created', (_e, win) => hookLights(win));
  on('ws:win-drag', (e, phase) => {
    const win = BrowserWindow.fromWebContents(e.sender), id = e.sender.id;
    if (!win) return;
    if (phase === 'end') { if (winDrags.delete(id)) keepLights(win); return; }
    if (phase === 'start') {
      if (win.isFullScreen() || (process.platform !== 'darwin' && win.isMaximized())) return winDrags.delete(id);
      return winDrags.set(id, { p: screen.getCursorScreenPoint(), at: win.getPosition() });
    }
    const d = winDrags.get(id);
    if (!d) return;
    // Con trỏ chưa rời điểm bấm thì không đặt lại: đặt vị trí lúc đang phóng to làm Electron
    // coi đó là cỡ người dùng chọn, nhấp đúp sau đó không thu về được nữa.
    const p = screen.getCursorScreenPoint();
    if (p.x === d.p.x && p.y === d.p.y) return;
    win.setPosition(d.at[0] + p.x - d.p.x, d.at[1] + p.y - d.p.y);
    keepLights(win);
  });
  // Nhấp đúp như thanh tiêu đề: macOS theo cài đặt "Nhấp đúp thanh tiêu đề để…" (Phóng to/Thu nhỏ/Không).
  on('ws:win-zoom', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isFullScreen()) return;
    const act = process.platform === 'darwin' ? systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string') : '';
    if (act === 'Minimize') return win.minimize();
    if (act === 'None') return;
    win.isMaximized() ? win.unmaximize() : win.maximize();
  });

  // Tệp
  handle('ws:file-stash', (e, paths) => (paths || []).map(stashPath));
  handle('ws:file-save', (e, bytes, name) => saveBytes(bytes, name));
  handle('ws:clipboard-image', () => {
    const img = clipboard.readImage();
    return img.isEmpty() ? null : saveBytes(img.toPNG(), 'clipboard.png');
  });
  handle('ws:shots', () => recentShots());
  handle('ws:reveal', (e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });
  handle('ws:thumb', async (e, p) => {
    if (!/\.(png|jpe?g|gif|webp)$/i.test(p || '')) return null;
    const img = nativeImage.createFromPath(p);
    if (img.isEmpty()) return null;
    const { width } = img.getSize();
    return (width > 640 ? img.resize({ width: 640 }) : img).toDataURL();
  });

  // Agents
  handle('ws:agents', () => agentList());
  // Repo đang có trong tab Git (để chọn thư mục cho canvas mới). Server Git chưa sẵn thì trả rỗng.
  handle('ws:repos', () => new Promise((done) => {
    const req = http.get(`${gitOrigin()}/api/git/repos`, (res) => {
      let txt = '';
      res.on('data', (b) => { txt += b; });
      res.on('end', () => {
        try { done(JSON.parse(txt).filter((r) => r?.dir).map((r) => ({ id: r.id, name: r.label || r.id, path: r.dir, branch: r.status?.branch || '' }))); } catch { done([]); }
      });
    });
    req.on('error', () => done([]));
    req.setTimeout(5000, () => { req.destroy(); done([]); });
  }));
  handle('ws:canvas-stats', (e, projectId) => canvasStats(projectId));

  // Giới hạn CPU / RAM (agentd): áp cho mọi phiên PTY, kể cả khay Terminal của tab Git.
  handle('ws:limits', () => agentd.call('limits'));
  handle('ws:limits-set', async (e, next) => {
    const r = await agentd.call('limits-set', cleanLimits(next));
    settings?.save({ limits: r.limits });
    return r;
  });

  // Đóng stdin: agentd cho cây con đang bị hãm chạy lại, tắt mọi phiên rồi thoát. will-quit chứ
  // không phải before-quit: người dùng bấm Cancel ở hộp hỏi thoát thì phiên vẫn sống.
  app.on('will-quit', () => agentd.stop());
}

module.exports = {
  setup,
  notchList,
  sessionsRunning: () => sessions.size,
  ownerOf: (projectId) => owners.get(projectId) ?? null,   // webContents.id của cửa sổ đang mở project
};
