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

  pathOf: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  stash: (paths) => ipcRenderer.invoke('ws:file-stash', paths),
  saveFile: (bytes, name) => ipcRenderer.invoke('ws:file-save', bytes, name),
  clipboardImage: () => ipcRenderer.invoke('ws:clipboard-image'),
  shots: () => ipcRenderer.invoke('ws:shots'),
  thumb: (p) => ipcRenderer.invoke('ws:thumb', p),
  reveal: (p) => ipcRenderer.invoke('ws:reveal', p),

  agents: () => ipcRenderer.invoke('ws:agents'),
  canvasStats: (projectId) => ipcRenderer.invoke('ws:canvas-stats', projectId),
  // Header tab Git (trong iframe) dời cửa sổ thay cho -webkit-app-region.
  winDrag: (phase) => ipcRenderer.send('ws:win-drag', phase),
  winZoom: () => ipcRenderer.send('ws:win-zoom'),
  // Mức zoom của trang (⌘+ / ⌘−) để rail giữ nguyên cỡ.
  zoomFactor: () => webFrame.getZoomFactor(),

  // Giới hạn CPU / RAM chung cho mọi terminal.
  limits: () => ipcRenderer.invoke('ws:limits'),
  setLimits: (l) => ipcRenderer.invoke('ws:limits-set', l),
  onLimitAlert: listeners('ws:limit-alert'),

  onCommand: listeners('ws:command'),
});
