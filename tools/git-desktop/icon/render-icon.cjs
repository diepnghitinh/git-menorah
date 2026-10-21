// Dựng icon app từ icon.svg — chạy khi đổi icon.svg, kết quả commit cùng repo:
//
//   cd tools/git-desktop && npm run icon
//
// Ra icon.png (1024), icon.ico (Windows, PNG nhúng 16…256) và — trên macOS — icon.icns
// (qua `iconutil` có sẵn của hệ thống). Vẽ bằng Chromium của Electron nên không cần
// thêm công cụ chuyển ảnh nào.

const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const DIR = __dirname;
const svg = readFileSync(path.join(DIR, 'icon.svg'), 'utf8');

// Vẽ SVG lên <canvas> trong một cửa sổ ẩn rồi lấy PNG — không cần chụp màn hình. SVG lỗi
// cú pháp (vd. `--` trong chú thích XML) thì `img.decode()` báo lỗi, không ra ảnh rỗng.
async function render(win, size) {
  const src = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const url = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image(); img.src = ${JSON.stringify(src)}; await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = ${size};
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, ${size}, ${size});
    return c.toDataURL('image/png');
  })()`);
  return Buffer.from(url.split(',')[1], 'base64');
}

// ICO = phần đầu 6 byte + mỗi ảnh một mục 16 byte + dữ liệu PNG (Windows Vista trở lên đọc PNG nhúng).
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(({ size, buf }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += buf.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.buf)]);
}

async function main() {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<html></html>');
  const png = {};
  for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) png[s] = await render(win, s);

  writeFileSync(path.join(DIR, 'icon.png'), png[1024]);
  writeFileSync(path.join(DIR, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, buf: png[size] }))));

  if (process.platform !== 'darwin') return console.log('Wrote icon.png, icon.ico — icon.icns can only be built on macOS (iconutil); keeping the committed one.');
  const tmp = mkdtempSync(path.join(tmpdir(), 'gitmenorah-icon-'));
  const set = path.join(tmp, 'icon.iconset');
  mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    writeFileSync(path.join(set, `icon_${s}x${s}.png`), png[s]);
    writeFileSync(path.join(set, `icon_${s}x${s}@2x.png`), png[s * 2]);
  }
  try { execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(DIR, 'icon.icns')]); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
  console.log('Wrote icon.png, icon.ico, icon.icns');
}

app.whenReady()
  .then(main)
  .catch((e) => { console.error(e?.message || e?.name || e); process.exitCode = 1; })
  .finally(() => app.quit());
