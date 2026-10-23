// Báo bản mới từ GitHub Releases (diepnghitinh/git-menorah).
//
// Chỉ báo, không tự cài: bản build là .dmg / .zip chưa ký, Squirrel/electron-updater không
// dùng được. Có bản mới thì hiện ghi chú release (phần "New / Fixes" viết lúc phát hành) và
// nút Download mở đúng tệp cho máy này (GitMenorah-<ver>-macosx-arm64.dmg…), không có thì mở
// trang release.
//
// Tự kiểm 15s sau khi mở rồi 6 giờ/lần. Mỗi bản chỉ hỏi một lần mỗi lần chạy app; "Skip This
// Version" thì thôi hẳn bản đó. Lỗi mạng khi tự kiểm thì im lặng — chỉ báo khi người dùng bấm
// Check for Updates….

const { dialog, net, shell, BrowserWindow } = require('electron');

const REPO = 'diepnghitinh/git-menorah';
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;   // bỏ qua draft và prerelease
const FIRST = 15e3, EVERY = 6 * 3600e3;

// '1.0.10' > '1.0.9'; tag có thể có 'v' đầu. Phần không phải số (-beta…) bỏ qua.
const parts = (v) => String(v).trim().replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
function newer(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function assetFor(rel) {
  const plat = { darwin: 'macosx', win32: 'windows' }[process.platform];
  if (!plat) return null;
  const ext = plat === 'macosx' ? '.dmg' : '.zip';
  const want = (arch) => rel.assets?.find((a) => a.name.endsWith(`-${plat}-${arch}${ext}`));
  // Chưa có bản arm64 cho Windows thì bản x64 vẫn chạy được (giả lập).
  return want(process.arch) || (plat === 'windows' && want('x64')) || null;
}

// Ghi chú release từ GitHub (Markdown, \r\n) → chữ thường cho hộp thoại.
function notes(body) {
  const s = String(body || '').replace(/\r\n/g, '\n').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/gm, '').trim();
  return s.length > 1800 ? s.slice(0, 1800).replace(/\n[^\n]*$/, '') + '\n…' : s;
}

function createUpdateCheck({ app, settings, onAuto }) {
  const asked = new Set();   // bản đã hỏi trong lần chạy này
  let timer = null, busy = false;

  async function fetchLatest() {
    const r = await net.fetch(LATEST, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `GitMenorah/${app.getVersion()}` },
      cache: 'no-store',
    });
    if (!r.ok) throw new Error(r.status === 404 ? 'No release has been published yet.' : `GitHub answered ${r.status}.`);
    return r.json();
  }

  async function check({ manual = false } = {}) {
    if (busy) return;
    busy = true;
    try {
      const cur = app.getVersion();
      let rel;
      try { rel = await fetchLatest(); } catch (e) {
        if (manual) dialog.showMessageBox(BrowserWindow.getFocusedWindow(), { type: 'warning', message: 'Could not check for updates', detail: e.message });
        return;
      }
      const ver = String(rel.tag_name || rel.name || '').replace(/^v/i, '');
      if (!ver || !newer(ver, cur)) {
        if (manual) dialog.showMessageBox(BrowserWindow.getFocusedWindow(), { type: 'info', message: 'GitMenorah is up to date', detail: `You have ${cur}, the latest release.` });
        return;
      }
      if (!manual && (asked.has(ver) || settings.load().skipVersion === ver)) return;
      asked.add(ver);

      const asset = assetFor(rel);
      const auto = settings.load().updateCheck !== false;
      const r = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
        type: 'info',
        message: `GitMenorah ${ver} is available`,
        detail: `You have ${cur}.${rel.body ? '\n\n' + notes(rel.body) : ''}`,
        buttons: [asset ? 'Download' : 'Open Release Page', 'Later', 'Skip This Version'],
        defaultId: 0, cancelId: 1,
        checkboxLabel: 'Check for updates automatically', checkboxChecked: auto,
      });
      if (r.checkboxChecked !== auto) setAuto(r.checkboxChecked);
      if (r.response === 0) shell.openExternal(asset ? asset.browser_download_url : rel.html_url);
      if (r.response === 2) settings.save({ skipVersion: ver });
    } finally { busy = false; }
  }

  function setAuto(on) {
    settings.save({ updateCheck: on });
    clearTimeout(timer); clearInterval(timer); timer = null;
    if (on) start();
    onAuto?.(on);
  }

  function start() {
    if (timer || settings.load().updateCheck === false) return;
    timer = setTimeout(() => { check(); timer = setInterval(check, EVERY); }, FIRST);
  }

  return { start, check: () => check({ manual: true }), setAuto, auto: () => settings.load().updateCheck !== false };
}

module.exports = { createUpdateCheck, newer, assetFor };
