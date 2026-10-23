// Cầu nối trang app (menorah://app) ↔ tiến trình chính. Chạy sandbox: chỉ có ipcRenderer,
// contextBridge, webUtils. Không nạp vào iframe tab Git (preload chỉ chạy ở main frame).

const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

const listeners = (ch) => (fn) => {
  const h = (_e, p) => fn(p);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('menorah', {
  info: () => ipcRenderer.invoke('ws:info'),

  projects: () => ipcRenderer.invoke('ws:projects'),
  addProject: (dir) => ipcRenderer.invoke('ws:project-add', dir),
  removeProject: (id) => ipcRenderer.invoke('ws:project-remove', id),
  openProject: (id) => ipcRenderer.invoke('ws:project-open', id),
  openCanvas: (projectId, canvasId) => ipcRenderer.invoke('ws:canvas-open', projectId, canvasId),
  addCanvas: (projectId, opts) => ipcRenderer.invoke('ws:canvas-add', projectId, opts),
  repos: () => ipcRenderer.invoke('ws:repos'),
  renameCanvas: (projectId, canvasId, name) => ipcRenderer.invoke('ws:canvas-rename', projectId, canvasId, name),
  removeCanvas: (projectId, canvasId) => ipcRenderer.invoke('ws:canvas-remove', projectId, canvasId),
  saveCanvas: (projectId, canvasId, doc) => ipcRenderer.invoke('ws:canvas-save', projectId, canvasId, doc),

  ptyStart: (opts) => ipcRenderer.invoke('ws:pty-start', opts),
  ptyState: (ids) => ipcRenderer.invoke('ws:pty-state', ids),
  ptyWrite: (nodeId, data) => ipcRenderer.send('ws:pty-write', nodeId, data),
  ptyResize: (nodeId, cols, rows) => ipcRenderer.send('ws:pty-resize', nodeId, cols, rows),
  ptyKill: (nodeId) => ipcRenderer.invoke('ws:pty-kill', nodeId),
  ptyDetach: (nodeId) => ipcRenderer.send('ws:pty-detach', nodeId),
  onPtyData: listeners('ws:pty-data'),
  onPtyExit: listeners('ws:pty-exit'),
  onPtySession: listeners('ws:pty-session'),

  chatRead: (q) => ipcRenderer.invoke('ws:chat-read', q),
  subagents: (list) => ipcRenderer.invoke('ws:subagents', list),
  cache: () => ipcRenderer.invoke('ws:cache'),

  pathOf: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  stash: (paths) => ipcRenderer.invoke('ws:file-stash', paths),
  saveFile: (bytes, name) => ipcRenderer.invoke('ws:file-save', bytes, name),
  clipboardImage: () => ipcRenderer.invoke('ws:clipboard-image'),
  shots: () => ipcRenderer.invoke('ws:shots'),
  thumb: (p, max) => ipcRenderer.invoke('ws:thumb', p, max),
  reveal: (p) => ipcRenderer.invoke('ws:reveal', p),

  agents: () => ipcRenderer.invoke('ws:agents'),
  canvasStats: (projectId) => ipcRenderer.invoke('ws:canvas-stats', projectId),
  // Header tab Git (trong iframe) dời cửa sổ thay cho -webkit-app-region.
  winDrag: (phase) => ipcRenderer.send('ws:win-drag', phase),
  winZoom: () => ipcRenderer.send('ws:win-zoom'),
  // Chế độ màu của tab Git: 'auto' | 'light' | 'dark'.
  setTheme: (mode) => ipcRenderer.send('ws:theme', mode),
  // Mức zoom của trang (⌘+ / ⌘−) để rail giữ nguyên cỡ.
  zoomFactor: () => webFrame.getZoomFactor(),

  // Giới hạn CPU / RAM chung cho mọi terminal.
  limits: () => ipcRenderer.invoke('ws:limits'),
  setLimits: (l) => ipcRenderer.invoke('ws:limits-set', l),
  onLimitAlert: listeners('ws:limit-alert'),

  // Git cloud accounts (token goes to git's credential helper) and Clone from URL.
  accounts: () => ipcRenderer.invoke('ws:accounts'),
  accountsOp: (body) => ipcRenderer.invoke('ws:accounts-op', body),
  clone: (body) => ipcRenderer.invoke('ws:clone', body),
  cloneStatus: (job) => ipcRenderer.invoke('ws:clone-status', job),
  pickDir: (opts) => ipcRenderer.invoke('ws:pick-dir', opts),

  // AI Hub: nhà cung cấp (khóa API không bao giờ đọc ngược về đây), Inference Router, báo cáo SQLite.
  hub: () => ipcRenderer.invoke('ws:hub-state'),
  hubProviderSave: (x) => ipcRenderer.invoke('ws:hub-provider-save', x),
  hubProviderTest: (id) => ipcRenderer.invoke('ws:hub-provider-test', id),
  hubProviderRemove: (id) => ipcRenderer.invoke('ws:hub-provider-remove', id),
  hubRouterSave: (x) => ipcRenderer.invoke('ws:hub-router-save', x),
  hubReport: (days, project) => ipcRenderer.invoke('ws:hub-report', days, project),
  hubReportClear: () => ipcRenderer.invoke('ws:hub-report-clear'),
  // Ghi / trả lại ~/.claude/settings.json (ANTHROPIC_BASE_URL → proxy của Git Menorah).
  hubClaudeInstall: () => ipcRenderer.invoke('ws:hub-claude-install'),
  hubClaudeRestore: () => ipcRenderer.invoke('ws:hub-claude-restore'),
  hubJudgeTest: (prompt, router) => ipcRenderer.invoke('ws:hub-judge-test', prompt, router),

  onCommand: listeners('ws:command'),
});
