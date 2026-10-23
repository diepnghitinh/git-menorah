// Bảng agent ở tai thỏ. Poll danh sách phiên agent đang mở mỗi 1.5 giây rồi chọn chế độ:
//   hidden — không có phiên Claude Code / Codex nào đang mở
//   pill   — viên đen ôm tai thỏ: agent nổi bật nhất bên trái, số phiên bên phải
//   peek   — một agent vừa chạy xong lượt (đã chạy ≥ 6 giây) khi bạn đang ở app khác: ló ra 6 giây
//   open   — rê chuột vào: danh sách đủ, mỗi dòng có nút Mở nhảy tới node trên canvas
'use strict';

const N = { geo: null, items: [], hover: false, leaveT: null, peekId: null, peekUntil: 0, track: new Map(), focused: false, sent: '' };
const MARK = { claude: 'C', codex: 'X' };
const RUN_MIN_MS = 6000;   // lượt ngắn hơn (gõ phím, TUI vẽ lại) không tính là "xong việc"
const PEEK_MS = 6000;

function applyGeo(g) {
  if (!g) return;
  N.geo = g;
  document.documentElement.style.setProperty('--bar-h', `${g.barH}px`);
  document.documentElement.style.setProperty('--notch-w', `${g.notchW}px`);
  document.documentElement.style.setProperty('--open-w', `${g.openW}px`);
  document.body.classList.toggle('no-notch', !g.hasNotch);
  N.sent = '';
  update();
}

async function poll() {
  let r;
  try { r = await window.notch.list(); } catch { return; }
  if (!r) return;
  N.items = r.items;
  N.focused = r.appFocused;
  trackTurns();
  update();
}

// Đang chạy → chờ lệnh, sau một lượt đủ dài: báo bằng peek (trừ khi bạn đang nhìn app).
function trackTurns() {
  const now = Date.now();
  const seen = new Set();
  for (const it of N.items) {
    seen.add(it.nodeId);
    const t = N.track.get(it.nodeId) || { since: 0, last: 0 };
    if (it.status === 'running') {
      if (!t.since || now - t.last > 4000) t.since = now;
      t.last = now;
    } else if (t.since && now - t.last > 2500) {
      if (t.last - t.since >= RUN_MIN_MS && !N.focused) { N.peekId = it.nodeId; N.peekUntil = now + PEEK_MS; }
      t.since = 0;
    }
    N.track.set(it.nodeId, t);
  }
  for (const id of N.track.keys()) if (!seen.has(id)) N.track.delete(id);
}

function update() {
  if (!N.geo) return;
  if (!N.items.length) N.hover = false;
  const peek = N.peekId && Date.now() < N.peekUntil && N.items.find((x) => x.nodeId === N.peekId);
  if (!peek) N.peekId = null;
  const mode = !N.items.length ? 'hidden' : N.hover ? 'open' : peek ? 'peek' : 'pill';
  $('#island').className = mode;
  renderBar(mode);
  let h = 0;
  if (mode === 'open') { renderList(); h = $('#list').scrollHeight; }
  if (mode === 'peek') renderPeek(peek);
  const key = `${mode}:${h}`;
  if (key !== N.sent) { N.sent = key; window.notch.mode(mode, h); }
}

// ─── Vẽ ──────────────────────────────────────────────────────────────────
const mark = (agent, cls = '') => h(`span.mark.${agent}${cls}`, MARK[agent] || '?');
const bars = () => h('span.bars', h('i'), h('i'), h('i'));

function counts() {
  const run = N.items.filter((x) => x.status === 'running').length;
  return { run, idle: N.items.length - run };
}

function renderBar(mode) {
  const L = $('#wing-left');
  const R = $('#wing-right');
  const { run, idle } = counts();
  const sum = [run && `${run} running`, idle && `${idle} waiting`].filter(Boolean).join(' · ');
  if (mode === 'open') {
    L.replaceChildren(h('span.bar-title', 'Agent'));
    R.replaceChildren(h('span.summary', sum));
    return;
  }
  const top = N.items[0];
  if (!top) { L.replaceChildren(); R.replaceChildren(); return; }
  L.replaceChildren(...[mark(top.agent), run && bars()].filter(Boolean));
  R.replaceChildren(N.geo.hasNotch
    ? h(`span.count.${run ? 'run' : 'idle'}`, { title: sum }, String(run || N.items.length))
    : h('span.summary', sum));
}

function where(it) { return `${it.projectName} / ${it.canvasName}`; }

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`;
}
function ago(t) {
  const m = Math.floor((Date.now() - t) / 60e3);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hr = Math.floor(m / 60);
  return hr < 24 ? `${hr} h ago` : `${Math.floor(hr / 24)} d ago`;
}

function meta(it) {
  const out = [];
  if (it.status === 'running') {
    const from = it.turnAt && it.turnAt >= it.startedAt - 60e3 ? it.turnAt : it.startedAt;
    out.push(h('span.run', `Running ${clock(Date.now() - from)}`));
  } else out.push(h('span', `Waiting · ${ago(it.lastAt || it.startedAt)}`));
  if (it.model) out.push(h('span', it.model));
  if (it.ctxUsed !== undefined && it.ctxMax) {
    const pct = Math.min(100, Math.round((it.ctxUsed / it.ctxMax) * 100));
    out.push(h(`span${pct >= 80 ? '.warn' : ''}`, { title: `${Math.round(it.ctxUsed / 1000)}k / ${Math.round(it.ctxMax / 1000)}k token` }, `${pct}% context`));
  }
  if (it.subs) out.push(h('span.run', `${it.subs} sub agent`));
  // Prompt cache của Claude: còn bao lâu thì nguội (qua mốc, prompt kế tiếp ghi lại cả context).
  if (it.status !== 'running' && it.cacheAt && !it.compacted) {
    const ttl = (it.cacheTtl || 3600) * 1e3, left = it.cacheAt + ttl - Date.now();
    out.push(left <= 0
      ? h('span.warn', { title: 'Prompt cache expired — run /compact before the next prompt' }, 'cache cold')
      : h(`span${left <= Math.min(5 * 60e3, ttl / 5) ? '.warn' : ''}`, { title: 'Prompt cache stays warm until then' }, `cache ${clock(left)}`));
  }
  return out.flatMap((x, i) => (i ? [h('span', '·'), x] : [x]));
}

function go(it) {
  window.notch.go({ projectId: it.projectId, nodeId: it.nodeId, canvasId: it.canvasId });
  N.hover = false; N.peekId = null;
  update();
}

function renderList() {
  $('#list').replaceChildren(...N.items.map((it) => h('div.row',
    mark(it.agent, '.lg'),
    h('div.r-main',
      h('div.r-head', h('span.r-title', it.title), h('span.r-where', where(it))),
      h('div.r-you', it.you ? [h('b', 'You: '), it.you] : 'No messages yet'),
      h('div.r-meta', meta(it))),
    h('div.r-side', h(`span.dot.${it.status}`), h('button.go', { title: 'Open this node on the canvas', onclick: () => go(it) }, 'Open')))));
}

function renderPeek(it) {
  $('#peek').replaceChildren(
    mark(it.agent, '.lg'),
    h('div.peek-text', h('div', h('b', it.title), ' finished its turn'), h('div.peek-sub', it.you ? `You: ${it.you}` : where(it))),
    h('button.go', { onclick: () => go(it) }, 'Open'));
}

// ─── Khởi động ───────────────────────────────────────────────────────────
(async () => {
  const island = $('#island');
  island.addEventListener('mouseenter', () => { clearTimeout(N.leaveT); if (!N.hover) { N.hover = true; update(); } });
  island.addEventListener('mouseleave', () => { clearTimeout(N.leaveT); N.leaveT = setTimeout(() => { N.hover = false; update(); }, 350); });
  // ⌘+ / ⌘− ở cửa sổ chính đổi cỡ viewport ở đây. Chính app đổi cỡ cửa sổ cũng ra resize,
  // nên chỉ đo lại khi mức zoom thật sự đổi.
  let z = 0;
  const unzoom = () => {
    const f = window.notch.zoomFactor() || 1;
    if (f === z) return;
    z = f;
    document.documentElement.style.setProperty('--z', String(1 / f));
    N.sent = ''; update();
  };
  unzoom();
  window.addEventListener('resize', unzoom);
  window.notch.onGeo(applyGeo);
  applyGeo(await window.notch.geo());
  await poll();
  setInterval(poll, 1500);
  setInterval(() => { if (N.hover || N.peekId) update(); }, 1000);
})();
