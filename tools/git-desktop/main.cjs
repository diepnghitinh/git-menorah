// GitMenorah — agent canvas (Claude Code, Codex, terminal) + the Git page (tools/git.html) as a
// desktop app.
//
//   cd tools/git-desktop && npm install && npm start     # run from source
//   tools/build-git.sh --platform=macosx|windows         # package
//
// The app has no git logic of its own. It runs `git-server.mjs` (on the Node inside Electron)
// on its own 127.0.0.1 port and shows the Git page from it. Gitflow rules, the secret-file
// guard, dry-run → confirm… all live in the server — change them there and rebuild.
//
// The package copies git.html + git-server.mjs into `server/tools/` (build-git.sh); from
// source the app uses the two files in `tools/` directly.
//
// The window loads the app page `menorah://app/index.html` (folder app/): Canvas · Agents ·
// Git tabs. The Git screen is an iframe on the server above; Canvas runs PTYs through
// workspace/backend.cjs. Requests from the Git page go through the `ALLOWED` whitelist.

const { app, BrowserWindow, Menu, dialog, nativeTheme, shell, session, protocol, net } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const workspace = require('./workspace/backend.cjs');
const { createNotch } = require('./workspace/notch.cjs');

const SERVER = [
  path.join(__dirname, 'server', 'tools', 'git-server.mjs'),
  path.join(__dirname, '..', 'git-server.mjs'),
].find(existsSync);
const GUARD = path.join(__dirname, 'workspace', 'server-guard.mjs');

// Cổng cố định để localStorage (giao diện, cỡ khung, repo chọn gần nhất) giữ được giữa
// các lần mở — origin đổi theo cổng. Cổng đầu bận thì lùi sang cổng sau.
const PORTS = [4991, 4992, 4993, 4994, 4995];
const ALLOWED = [/^\/$/, /^\/git\.html$/, /^\/api\/git\//, /^\/git-view\//, /^\/vendor\/(xterm|addon-fit|addon-unicode11|addon-web-links)\//];

let server = null;   // { child, port, origin }
let quitting = false;

// ─── Trang app (menorah://app) ─────────────────────────────────────────────
// Giao thức riêng thay cho file:// để trang có origin cố định (localStorage giữ được) và chỉ
// đọc được hai chỗ: app/ và mấy gói xterm trong node_modules.
const APP_ORIGIN = 'menorah://app';
protocol.registerSchemesAsPrivileged([{ scheme: 'menorah', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const VENDOR = {
  'xterm/': path.join(__dirname, 'node_modules', '@xterm', 'xterm'),
  'addon-fit/': path.join(__dirname, 'node_modules', '@xterm', 'addon-fit'),
  'addon-unicode11/': path.join(__dirname, 'node_modules', '@xterm', 'addon-unicode11'),
  'addon-web-links/': path.join(__dirname, 'node_modules', '@xterm', 'addon-web-links'),
};
function serveApp() {
  protocol.handle('menorah', async (req) => {
    const u = new URL(req.url);
    if (u.host !== 'app') return new Response('not found', { status: 404 });
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    let base = path.join(__dirname, 'app');
    if (rel.startsWith('vendor/')) {
      rel = rel.slice(7);
      const k = Object.keys(VENDOR).find((p) => rel.startsWith(p));
      if (!k) return new Response('not found', { status: 404 });
      base = VENDOR[k]; rel = rel.slice(k.length);
    }
    const file = path.resolve(base, rel);
    if (!file.startsWith(base + path.sep) || !existsSync(file)) return new Response('not found', { status: 404 });
    // Tệp app đọc thẳng từ đĩa — không để Chromium giữ bản cũ sau khi sửa code (⌘R là thấy).
    const res = await net.fetch(pathToFileURL(file).toString());
    return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'no-store' } });
  });
}

// ─── Môi trường cho git ────────────────────────────────────────────────────
// App mở từ Finder chỉ có PATH tối thiểu (/usr/bin:/bin…) — git của Homebrew, git-lfs,
// credential helper nằm ở /opt/homebrew/bin hay /usr/local/bin thì không thấy.
function gitEnv() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  if (process.platform === 'darwin') {
    const extra = ['/opt/homebrew/bin', '/usr/local/bin'].filter((p) => !(env.PATH || '').split(':').includes(p));
    env.PATH = [...extra, env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(':');
  }
  return env;
}

function gitVersion(env) {
  try { return execFileSync('git', ['--version'], { env, timeout: 5000, windowsHide: true }).toString().trim(); }
  catch { return null; }
}

// ─── Server ────────────────────────────────────────────────────────────────
// Server in "git.html → http://127.0.0.1:<cổng>" khi đã nghe; cổng bận thì thoát mã 1.
function startOn(port, env) {
  return new Promise((done) => {
    // Qua server-guard: stdin để mở thành ống, app chết thì server tự thoát theo.
    const child = spawn(process.execPath, [GUARD, SERVER, `--port=${port}`], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', ready = false;
    const onData = (b) => {
      out += b;
      if (!ready && out.includes(`127.0.0.1:${port}`)) { ready = true; done({ child, port, origin: `http://127.0.0.1:${port}` }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (b) => { out += b; });
    child.once('exit', (code) => {
      if (!ready) return done({ error: out.trim() || `exit ${code}` });
      if (!quitting) serverDied(out);
    });
  });
}

async function startServer(env) {
  let last = '';
  for (const port of PORTS) {
    const r = await startOn(port, env);
    if (!r.error) return r;
    last = r.error;
  }
  throw new Error(`Could not start the local server on ports ${PORTS.join(', ')}.\n\n${last}`);
}

function serverDied(out) {
  dialog.showErrorBox('GitMenorah stopped', `The local server exited unexpectedly.\n\n${out.trim().split('\n').slice(-12).join('\n')}`);
  app.quit();
}

// Gọi API của server từ tiến trình chính (menu Add Repository…). POST cần X-Dev-Runner.
function api(pathname, body) {
  return new Promise((done, fail) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(`${server.origin}${pathname}`, {
      method: data ? 'POST' : 'GET',
      headers: data ? { 'content-type': 'application/json', 'x-dev-runner': '1', 'content-length': data.length } : {},
    }, (res) => {
      let txt = '';
      res.on('data', (b) => { txt += b; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(txt); } catch {}
        if (res.statusCode >= 400) fail(new Error(j?.error || `HTTP ${res.statusCode}`));
        else done(j);
      });
    });
    req.on('error', fail);
    req.end(data);
  });
}

// ─── Cửa sổ ────────────────────────────────────────────────────────────────
// Cỡ và vị trí cửa sổ đầu tiên nhớ ở userData/window.json; cửa sổ mở thêm lệch ra một chút.
const BOUNDS_FILE = () => path.join(app.getPath('userData'), 'window.json');
function loadBounds() {
  try { return JSON.parse(readFileSync(BOUNDS_FILE(), 'utf8')); } catch { return { width: 1440, height: 900 }; }
}
function saveBounds(win) {
  if (win.isMinimized() || win.isFullScreen()) return;
  try {
    mkdirSync(path.dirname(BOUNDS_FILE()), { recursive: true });
    writeFileSync(BOUNDS_FILE(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch {}
}

const sameOrigin = (url) => { try { return new URL(url).origin === server.origin; } catch { return false; } };
const appPage = (url) => { try { return url.startsWith(`${APP_ORIGIN}/`); } catch { return false; } };

// `query` là query của tab Git (`git=` hoặc `git=<repo>`); `view` là tab mở đầu.
function createWindow(query = 'git=', offset = 0, view) {
  const b = loadBounds();
  const win = new BrowserWindow({
    width: b.width, height: b.height,
    ...(b.x !== undefined && { x: b.x + offset, y: b.y + offset }),
    minWidth: 900, minHeight: 560,
    title: 'GitMenorah',
    // macOS: bỏ thanh tiêu đề, ba nút đèn nằm giữa đầu rail trái (--rail-w 84px ở app.css), kéo rail để dời cửa sổ.
    ...(process.platform === 'darwin' && { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 16 } }),
    // Nền trùng --bg của git.html (sáng/tối) để không loé trắng lúc trang chưa vẽ.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1318' : '#f6f7f9',
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, preload: path.join(__dirname, 'workspace', 'preload.cjs') },
  });
  if (b.maximized && !offset) win.maximize();
  win.once('ready-to-show', () => win.show());
  if (!offset) {
    win.on('resize', () => saveBounds(win));
    win.on('move', () => saveBounds(win));
  }

  // Trang mở tab mới bằng window.open: repo khác (?git=…) và tệp .html xem như web
  // (/git-view/…) mở thành cửa sổ app; link ra ngoài mở bằng trình duyệt hệ thống.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) {
      const u = new URL(url);
      if (u.pathname.startsWith('/git-view/')) return { action: 'allow', overrideBrowserWindowOptions: { width: 1200, height: 860, autoHideMenuBar: true } };
      createWindow(u.searchParams.toString() || 'git=', 28 * BrowserWindow.getAllWindows().length, 'git');
      return { action: 'deny' };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (appPage(url)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  // Tab Git là iframe: link trong đó tự điều hướng thì chỉ cho đi trong server.
  win.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame || sameOrigin(e.url) || appPage(e.url)) return;
    e.preventDefault();
    if (/^https?:/.test(e.url)) shell.openExternal(e.url);
  });

  const q = new URLSearchParams({ git: new URLSearchParams(query).get('git') ?? '', ...(view && { view }) });
  win.loadURL(`${APP_ORIGIN}/index.html?${q}`);
  return win;
}

// Chặn ở tầng request: trang chỉ được gọi các route trong ALLOWED.
function guardRequests() {
  session.defaultSession.webRequest.onBeforeRequest({ urls: [`${server.origin}/*`] }, (d, cb) => {
    const u = new URL(d.url);
    cb(ALLOWED.some((re) => re.test(u.pathname)) ? {} : { cancel: true });
  });
}

// ─── Tai thỏ ───────────────────────────────────────────────────────────────
// Bật/tắt nhớ ở userData/settings.json; mặc định bật. Chỉ macOS (notch.cjs tự bỏ qua nơi khác).
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() { try { return JSON.parse(readFileSync(SETTINGS_FILE(), 'utf8')); } catch { return {}; } }
function saveSettings(patch) {
  try { writeFileSync(SETTINGS_FILE(), JSON.stringify({ ...loadSettings(), ...patch }, null, 1)); } catch {}
}

let notch = null;
function setNotch(on) {
  if (on && !notch) {
    notch = createNotch({
      url: `${APP_ORIGIN}/notch.html`,
      preload: path.join(__dirname, 'workspace', 'notch-preload.cjs'),
      list: () => workspace.notchList(),
      appFocused: () => !!BrowserWindow.getFocusedWindow(),
      go: goNode,
    });
  } else if (!on && notch) { notch.destroy(); notch = null; }
}

// Nút Mở ở tai thỏ: đưa cửa sổ đang giữ project lên trước; chưa cửa sổ nào giữ thì dùng cửa
// sổ app gần nhất (trang tự mở project), không còn cửa sổ nào thì mở mới.
function goNode(it) {
  const wcId = workspace.ownerOf(it.projectId);
  const appWins = mainWindows();
  let win = wcId != null && appWins.find((w) => w.webContents.id === wcId);
  win ||= appWins[0];
  const send = () => command(win, { type: 'focus-node', ...it });
  if (!win) { win = createWindow(); win.webContents.once('did-finish-load', () => setTimeout(send, 300)); }
  else send();
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
  win.focus();
}

// ─── Menu ──────────────────────────────────────────────────────────────────
// Chỉ tải lại iframe Git — tải cả trang thì canvas vẽ lại (PTY vẫn sống nhưng nháy).
function reloadAll() {
  for (const w of BrowserWindow.getAllWindows()) command(w, { type: 'git-reload' });
}
function command(win, cmd) {
  if (win && !win.isDestroyed() && !notch?.owns(win) && appPage(win.webContents.getURL())) win.webContents.send('ws:command', cmd);
}
const toFocused = (cmd) => () => command(BrowserWindow.getFocusedWindow(), cmd);
// Cửa sổ chính (trang index.html) — không tính cửa sổ tai thỏ.
const mainWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && !notch?.owns(w));

async function pickDir(title) {
  const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), { title, properties: ['openDirectory', 'dontAddToRecent'] });
  return r.canceled ? null : r.filePaths[0];
}

async function addRepository() {
  const dir = await pickDir('Add a git repository');
  if (!dir) return;
  try { await api('/api/git/extra', { path: dir }); reloadAll(); }
  catch (e) { dialog.showErrorBox('Could not add repository', e.message); }
}

// Một thư mục chứa nhiều repo thành một nhóm project (tên = tên thư mục); server quét repo
// bên trong và lưu ở ~/.config/gitmenorah/git.json.
async function addProjectFolder() {
  const dir = await pickDir('Add a folder that contains git repositories');
  if (!dir) return;
  try { await api('/api/git/groups', { path: dir, name: path.basename(dir) }); reloadAll(); }
  catch (e) { dialog.showErrorBox('Could not add project folder', e.message); }
}

async function firstRunHint(win) {
  let repos = [];
  try { repos = await api('/api/git/repos'); } catch { return; }
  if (repos.length) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    message: 'No repositories yet',
    detail: 'Clone one from a URL, add a git repository on this machine, or a folder that holds several of them.',
    buttons: ['Clone from URL…', 'Add Repository…', 'Add Project Folder…', 'Later'],
    defaultId: 0, cancelId: 3,
  });
  if (response === 0) command(win, { type: 'clone' });
  if (response === 1) addRepository();
  if (response === 2) addProjectFolder();
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  const template = [
    ...(mac ? [{
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: toFocused({ type: 'settings' }) },
        { label: 'Accounts…', click: toFocused({ type: 'settings', tab: 'accounts' }) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow('git=', 28 * mainWindows().length) },
        { type: 'separator' },
        { label: 'New Claude Code', accelerator: 'CmdOrCtrl+T', click: toFocused({ type: 'new-node', agent: 'claude' }) },
        { label: 'New Codex', accelerator: 'CmdOrCtrl+Shift+T', click: toFocused({ type: 'new-node', agent: 'codex' }) },
        { label: 'New Terminal', accelerator: 'CmdOrCtrl+Alt+T', click: toFocused({ type: 'new-node', agent: 'shell' }) },
        { label: 'New Note', click: toFocused({ type: 'new-node', kind: 'note' }) },
        { type: 'separator' },
        { label: 'Open Folder as Project…', click: toFocused({ type: 'add-project' }) },
        { type: 'separator' },
        { label: 'Clone Repository…', accelerator: mac ? 'Cmd+Shift+C' : 'Ctrl+Alt+C', click: toFocused({ type: 'clone' }) },
        { label: 'Add Repository…', accelerator: 'CmdOrCtrl+O', click: addRepository },
        { label: 'Add Project Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: addProjectFolder },
        { type: 'separator' },
        ...(mac ? [] : [{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: toFocused({ type: 'settings' }) }, { label: 'Accounts…', click: toFocused({ type: 'settings', tab: 'accounts' }) }, { type: 'separator' }]),
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    // Thiếu menu Edit thì trên macOS Cmd+C / Cmd+V trong ô nhập không chạy.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Project · Git', accelerator: 'CmdOrCtrl+1', click: toFocused({ type: 'view', view: 'git' }) },
        { label: 'Canvas', accelerator: 'CmdOrCtrl+2', click: toFocused({ type: 'view', view: 'canvas' }) },
        { label: 'Agents', accelerator: 'CmdOrCtrl+3', click: toFocused({ type: 'view', view: 'agents' }) },
        { type: 'separator' },
        { label: 'Fit Canvas', accelerator: 'CmdOrCtrl+0', click: toFocused({ type: 'fit' }) },
        ...(mac ? [{
          label: 'Show Agents at the Notch', type: 'checkbox', checked: !!notch,
          click: (item) => { setNotch(item.checked); saveSettings({ notch: item.checked }); },
        }] : []),
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── Khởi động ─────────────────────────────────────────────────────────────
// Một bản chạy: mở lần hai thì đưa cửa sổ đang có lên trước — hai server cùng ghi một
// repo thì khoá `gitBusy` của từng server không thấy nhau.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = mainWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });

  app.whenReady().then(async () => {
    if (!SERVER) {
      dialog.showErrorBox('GitMenorah', 'git-server.mjs is missing from this build — rebuild with tools/build-git.sh.');
      return app.quit();
    }
    const env = gitEnv();
    if (!gitVersion(env)) {
      const { response } = await dialog.showMessageBox({
        type: 'error',
        message: 'Git is not installed',
        detail: process.platform === 'win32'
          ? 'Install Git for Windows, then open GitMenorah again.'
          : 'Install Git (Xcode Command Line Tools: xcode-select --install, or Homebrew), then open GitMenorah again.',
        buttons: ['Download Git', 'Quit'], defaultId: 0, cancelId: 1,
      });
      if (response === 0) await shell.openExternal('https://git-scm.com/downloads');
      return app.quit();
    }
    try { server = await startServer(env); }
    catch (e) { dialog.showErrorBox('GitMenorah', e.message); return app.quit(); }

    guardRequests();
    serveApp();
    await workspace.setup({ app, gitOrigin: () => server.origin, api, settings: { load: loadSettings, save: saveSettings } });
    setNotch(loadSettings().notch !== false);
    buildMenu();
    const win = createWindow(undefined, 0);
    win.webContents.once('did-finish-load', () => firstRunHint(win));

    app.on('activate', () => { if (!mainWindows().length) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  // Thoát app là tắt mọi phiên agent — hỏi trước nếu còn phiên chạy.
  let quitConfirmed = false;
  app.on('before-quit', (e) => {
    const n = workspace.sessionsRunning();
    if (!quitConfirmed && n > 0) {
      const r = dialog.showMessageBoxSync({
        type: 'warning', message: `${n} terminal / agent is still running`,
        detail: 'Quitting GitMenorah stops them. Claude Code and Codex sessions can be resumed from the canvas next time.',
        buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1,
      });
      if (r !== 0) return e.preventDefault();
    }
    quitConfirmed = true;
    quitting = true;
    server?.child.kill();
  });
}
