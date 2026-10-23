// Tiện ích dùng chung cho trang app: dựng DOM, icon, markdown gọn, toast, hộp thoại, trích
// đường dẫn tệp kéo thả.
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// h('div.cls#id', { onclick, title, ... }, ...children) — đủ dùng, khỏi framework.
function h(tag, attrs, ...kids) {
  const m = tag.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement(m[1] || 'div');
  for (const part of m[2].match(/[.#][\w-]+/g) || []) part[0] === '.' ? el.classList.add(part.slice(1)) : (el.id = part.slice(1));
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}

const ICON = {
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  play: '<path d="m6 4 14 8-14 8V4Z"/>',
  restart: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  focus: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  send: '<path d="m5 12 14-7-4 14-3-6-7-1Z"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-6 3-11 5.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  note: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M15 3v6h6"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
const icon = (name, cls = '') => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', `i ${cls}`); s.innerHTML = ICON[name]; return s; };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Markdown gọn cho tin của agent: khối code, code dòng, đậm/nghiêng, tiêu đề, danh sách, bảng.
// Thoát HTML trước rồi mới thay — không có chỗ nào chèn HTML thô từ transcript.
function md(src) {
  const blocks = [];
  let s = esc(src).replace(/```[^\n]*\n([\s\S]*?)(?:```|$)/g, (_, code) => { blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = (t) => t
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/g, '$1<i>$2</i>');
  const out = [];
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\u0000\d+\u0000$/.test(l.trim())) { out.push(l.trim()); continue; }
    const hd = l.match(/^(#{1,4})\s+(.*)$/);
    if (hd) { out.push(`<h${hd[1].length + 1}>${inline(hd[2])}</h${hd[1].length + 1}>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const row = (r, tg) => `<tr>${r.trim().replace(/^\||\|$/g, '').split('|').map((c) => `<${tg}>${inline(c.trim())}</${tg}>`).join('')}</tr>`;
      let t = `<table>${row(l, 'th')}`; i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) t += row(lines[i++], 'td');
      i--; out.push(`${t}</table>`); continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      let t = ordered ? '<ol>' : '<ul>';
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) t += `<li>${inline(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`;
      i--; out.push(t + (ordered ? '</ol>' : '</ul>')); continue;
    }
    if (!l.trim()) { out.push(''); continue; }
    let p = inline(l);
    while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#{1,4}\s|\s*([-*]|\d+\.)\s|\s*\||\u0000)/.test(lines[i + 1])) p += `<br>${inline(lines[++i])}`;
    out.push(`<p>${p}</p>`);
  }
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, n) => blocks[n]);
}

let toastT = null;
function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
}

// Hộp thoại nhỏ: build(dialogEl, close) dựng nội dung, trả Promise kết quả close(x).
function modal(build) {
  return new Promise((resolve) => {
    const m = $('#modal');
    const d = h('div.dialog');
    const close = (v) => { m.hidden = true; m.innerHTML = ''; document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    document.addEventListener('keydown', onKey, true);
    m.onclick = (e) => { if (e.target === m) close(null); };
    m.innerHTML = ''; m.append(d); m.hidden = false;
    build(d, close);
    d.querySelector('input,select,textarea,button.primary')?.focus();
  });
}

function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return modal((d, close) => d.append(
    h('h3', title), h('p', text),
    h('div.actions', h('button', { onclick: () => close(false) }, 'Cancel'), h(`button.primary`, { style: danger ? 'background:var(--danger);border-color:var(--danger)' : null, onclick: () => close(true) }, okLabel)),
  ));
}

// Đường dẫn chèn vào terminal: macOS/Linux thoát bằng \ như khi kéo tệp vào Terminal.app
// (Claude Code nhận ra đường dẫn ảnh dạng này), Windows bọc nháy kép.
const quotePath = (p, win) => (win ? (/[\s&()]/.test(p) ? `"${p}"` : p) : p.replace(/([^\w@%+=:,./-])/g, '\\$1'));

const isImage = (p) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(p || '');

// Tệp từ một sự kiện thả: tệp thật (có đường dẫn), ảnh kéo từ ô Ảnh vừa chụp (kiểu riêng),
// hoặc dữ liệu không có đường dẫn (ảnh kéo từ trình duyệt) → ghi vào uploads/.
async function droppedPaths(dt) {
  const own = dt.getData('application/x-menorah-path');
  if (own) return [own];
  const out = [];
  for (const f of dt.files || []) {
    const p = window.menorah.pathOf(f);
    if (p) out.push(p);
    else if (f.size) out.push(await window.menorah.saveFile(new Uint8Array(await f.arrayBuffer()), f.name || 'dropped.png'));
  }
  if (!out.length) {
    const uri = (dt.getData('text/uri-list') || '').split('\n').find((l) => l.startsWith('file://'));
    if (uri) out.push(decodeURIComponent(new URL(uri.trim()).pathname));
  }
  return out.length ? window.menorah.stash(out) : [];
}

function timeAgo(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h_ = Math.round(m / 60);
  return h_ < 24 ? `${h_} h ago` : `${Math.round(h_ / 24)} d ago`;
}

// ipcRenderer.invoke errors carry an "Error invoking remote method '…': Error: " prefix — drop it.
const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
