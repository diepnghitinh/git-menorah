// Bảng agent ở tai thỏ macOS: cửa sổ panel trong suốt, không viền, nổi trên thanh menu, căn
// giữa mép trên màn hình có tai thỏ (màn liền máy; không có thì màn chính).
//
// Thu gọn là viên đen ôm tai thỏ: cánh trái là agent nổi bật nhất, cánh phải là số phiên
// đang chạy. Rê chuột vào thì mở danh sách; một agent vừa chạy xong lượt thì "ló" ra một
// dòng vài giây. Trang notch.html tự quyết chế độ và chiều cao, ở đây chỉ đặt khung cửa sổ.
'use strict';

const { BrowserWindow, screen, ipcMain } = require('electron');

const NOTCH_W = 200;   // tai thỏ MacBook 14"/16" ở độ phân giải mặc định ~185pt, chừa mép
const WING_W = 64;     // mỗi cánh hai bên tai thỏ
const OPEN_W = 580;

function geometry() {
  const d = screen.getAllDisplays().find((x) => x.internal) || screen.getPrimaryDisplay();
  const bar = d.workArea.y - d.bounds.y;
  // Electron không báo vùng an toàn của tai thỏ: thanh menu cao ≥ 30pt ở màn liền máy là có.
  const hasNotch = !!d.internal && bar >= 30;
  return { display: d, barH: bar > 0 ? bar : (hasNotch ? 38 : 25), hasNotch, notchW: hasNotch ? NOTCH_W : 0, wingW: WING_W, openW: OPEN_W };
}

function createNotch({ url, preload, list, go, appFocused }) {
  if (process.platform !== 'darwin') return null;
  let geo = geometry();
  let mode = 'hidden';
  let win = null;

  const sizeFor = (m, h) => {
    const pillW = geo.hasNotch ? geo.notchW + 2 * geo.wingW : 220;
    if (m === 'pill') return { w: pillW, h: geo.barH };
    if (m === 'peek') return { w: Math.max(pillW, 460), h: geo.barH + 54 };
    return { w: OPEN_W, h: Math.min(Math.round(geo.display.workArea.height * 0.7), geo.barH + Math.max(60, h | 0)) };
  };

  const place = (m, h) => {
    if (!win || win.isDestroyed()) return;
    if (m === 'hidden') { mode = m; win.hide(); return; }
    const { w, h: hh } = sizeFor(m, h);
    const b = geo.display.bounds;
    const bounds = { x: Math.round(b.x + (b.width - w) / 2), y: b.y, width: w, height: hh };
    const animate = mode !== 'hidden' && win.isVisible();
    mode = m;
    win.setBounds(bounds, animate);
    if (!win.isVisible()) win.showInactive();
  };

  win = new BrowserWindow({
    type: 'panel', frame: false, transparent: true, hasShadow: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, focusable: false, acceptFirstMouse: true,
    enableLargerThanScreen: true, show: false, width: 260, height: 40, backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false, preload },
  });
  // Mức screen-saver: nằm trên thanh menu và trên ứng dụng toàn màn hình.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setHiddenInMissionControl?.(true);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadURL(url);

  const mine = (e) => win && !win.isDestroyed() && e.sender === win.webContents;
  const onGeo = () => { geo = geometry(); if (!win.isDestroyed()) win.webContents.send('notch:geo', geo); if (mode !== 'hidden') place(mode, lastH); };
  let lastH = 0;
  ipcMain.handle('notch:geo', (e) => (mine(e) ? geo : null));
  ipcMain.handle('notch:list', async (e) => (mine(e) ? { items: await list(), appFocused: appFocused() } : null));
  ipcMain.on('notch:mode', (e, m, h) => { if (mine(e) && ['hidden', 'pill', 'peek', 'open'].includes(m)) { lastH = h; place(m, h); } });
  ipcMain.on('notch:go', (e, it) => {
    if (!mine(e) || !it || typeof it.nodeId !== 'string') return;
    go({ projectId: String(it.projectId), nodeId: it.nodeId, canvasId: it.canvasId ? String(it.canvasId) : undefined });
  });
  screen.on('display-metrics-changed', onGeo);
  screen.on('display-added', onGeo);
  screen.on('display-removed', onGeo);

  return {
    owns: (w) => !!win && w === win,
    destroy() {
      for (const ch of ['notch:geo', 'notch:list']) ipcMain.removeHandler(ch);
      for (const ch of ['notch:mode', 'notch:go']) ipcMain.removeAllListeners(ch);
      screen.off('display-metrics-changed', onGeo); screen.off('display-added', onGeo); screen.off('display-removed', onGeo);
      if (!win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}

module.exports = { createNotch };
