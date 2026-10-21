// Cầu nối cho notch.html — chỉ bốn việc: đọc khung, đọc danh sách agent, đổi chế độ, nhảy tới node.
// zoomFactor: tai thỏ chung origin với cửa sổ chính nên ăn theo ⌘+ / ⌘− của app.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('notch', {
  geo: () => ipcRenderer.invoke('notch:geo'),
  list: () => ipcRenderer.invoke('notch:list'),
  mode: (m, h) => ipcRenderer.send('notch:mode', m, h),
  go: (it) => ipcRenderer.send('notch:go', it),
  onGeo: (fn) => ipcRenderer.on('notch:geo', (_e, g) => fn(g)),
  zoomFactor: () => webFrame.getZoomFactor(),
});
