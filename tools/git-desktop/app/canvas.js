// Canvas whiteboard của một project: node terminal (Claude Code / Codex / shell), ghi chú, ảnh;
// dây nối (link context) giữa các node.
//
// Toạ độ: doc lưu toạ độ "thế giới"; #world được translate + scale theo viewport. Kích thước
// terminal (cols/rows) tính bằng offsetWidth — không bị scale ảnh hưởng — nên zoom không đổi
// cỡ PTY. Toạ độ chuột của xterm được đổi về khung chưa scale (unscaleMouse), nên chọn chữ và
// bấm trong terminal đúng ô ở mọi mức zoom.
//
// Cuộn chuột: trên node đang chọn → node tự cuộn (terminal, chat, ghi chú); chỗ khác → pan.
// ⌘/Ctrl + cuộn (hoặc chụm hai ngón) → zoom quanh con trỏ.
'use strict';

const AGENTS = {
  claude: { label: 'Claude Code', mark: 'C' },
  codex: { label: 'Codex', mark: 'X' },
  shell: { label: 'Terminal', mark: '$' },
};
const MIN = { terminal: [360, 220], note: [180, 120], image: [40, 30] };
const DEFAULT_SIZE = { terminal: [720, 460], note: [260, 200], image: [360, 260] };
const XTERM_THEME = {
  background: '#11151c', foreground: '#d7dde6', cursor: '#d7dde6', cursorAccent: '#11151c', selectionBackground: '#33415a',
  black: '#1b2330', red: '#f2707a', green: '#4cc38a', yellow: '#e0a83a', blue: '#4c8dff', magenta: '#c38cf2', cyan: '#4cc3c3', white: '#d7dde6',
  brightBlack: '#6b7585', brightRed: '#ff8f97', brightGreen: '#6fdca6', brightYellow: '#f2c46a', brightBlue: '#7aabff', brightMagenta: '#d6aaf7', brightCyan: '#7adada', brightWhite: '#ffffff',
};

class Canvas {
  constructor(opts) {
    this.stage = $('#stage');
    this.world = $('#world');
    this.nodesEl = $('#nodes');
    this.svg = $('#links');
    this.info = opts.info;
    this.onChange = opts.onChange;
    this.onStatus = opts.onStatus || (() => {});
    this.onContextMenu = opts.onContextMenu || (() => {});
    this.project = null;
    this.doc = null;
    this.views = new Map();
    this.z = 10;
    this.active = null;
    this.selLink = null;
    this.saveSoon = debounce(() => this.save(), 400);

    window.menorah.onPtyData(({ nodeId, data }) => this.views.get(nodeId)?.term?.write(data));
    window.menorah.onPtyExit(({ nodeId, code }) => this.views.get(nodeId)?.exited(code));
    window.menorah.onPtySession(({ nodeId, sessionId }) => {
      const n = this.node(nodeId);
      if (n && n.sessionId !== sessionId) { n.sessionId = sessionId; this.saveSoon(); }
    });
    this.bindStage();
    this.bindMinimap();
    setInterval(() => this.pollStatus(), 1500);
    setInterval(() => this.pollSubagents(), 2000);
    // Prompt cache: hỏi mốc 10s/lần, đồng hồ trên node tự đếm từng giây giữa hai lần hỏi.
    setInterval(() => this.pollCache(), 10e3);
    setInterval(() => { for (const v of this.views.values()) v.tickCache?.(); }, 1000);
  }

  node(id) { return this.doc?.nodes.find((n) => n.id === id); }
  // Thư mục gốc của canvas đang mở: canvas gắn repo/thư mục riêng thì dùng nó, không thì thư mục project.
  rootCwd() { return this.project?.canvases?.find((c) => c.id === this.canvasId)?.cwd || this.project?.cwd; }

  // ─── Nạp / lưu ──────────────────────────────────────────────────────────
  // Đổi canvas: lưu canvas đang mở ngay (khỏi mất thay đổi còn chờ debounce), tách khỏi PTY
  // của các node cũ — phiên vẫn chạy nền, quay lại canvas thì gắn lại.
  async load(project, doc, canvasId) {
    if (this.project && this.canvasId) this.save();
    for (const v of this.views.values()) v.dispose(true);
    this.views.clear();
    this.nodesEl.innerHTML = '';
    this.project = project;
    this.canvasId = canvasId || null;
    this.doc = { version: 1, viewport: { x: 80, y: 80, zoom: 1 }, nodes: [], links: [], ...doc };
    this.applyViewport();
    const ids = this.doc.nodes.filter((n) => n.kind === 'terminal').map((n) => n.id);
    const state = ids.length ? await window.menorah.ptyState(ids) : {};
    for (const n of this.doc.nodes) this.mount(n, { running: state[n.id] && state[n.id] !== 'stopped' });
    this.drawLinks();
    this.refreshEmpty();
  }

  save() { if (this.project && this.canvasId) window.menorah.saveCanvas(this.project.id, this.canvasId, this.doc); this.onChange?.(); }
  changed() { this.saveSoon(); this.refreshEmpty(); }

  refreshEmpty() { $('#canvas-empty').hidden = !this.project || this.doc.nodes.length > 0; this.refreshResume(); this.drawMinimapSoon(); }
  refreshResume() {
    const stopped = [...this.views.values()].filter((v) => v.stopped && v.n.kind === 'terminal').length;
    $('#resume-all').hidden = !stopped;
    $('#resume-count').textContent = stopped > 1 ? `(${stopped})` : '';
  }

  // ─── Viewport ───────────────────────────────────────────────────────────
  applyViewport() {
    const { x, y, zoom } = this.doc.viewport;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    const g = 24 * zoom;
    this.stage.style.backgroundSize = `${g}px ${g}px`;
    this.stage.style.backgroundPosition = `${x}px ${y}px`;
    $('#zoom-reset').textContent = `${Math.round(zoom * 100)}%`;
    this.drawMinimapSoon();
  }

  toWorld(cx, cy) {
    const r = this.stage.getBoundingClientRect();
    const { x, y, zoom } = this.doc.viewport;
    return { x: (cx - r.left - x) / zoom, y: (cy - r.top - y) / zoom };
  }

  zoomAt(cx, cy, zoom) {
    const vp = this.doc.viewport;
    zoom = Math.min(2, Math.max(0.2, zoom));
    const r = this.stage.getBoundingClientRect();
    const px = cx - r.left; const py = cy - r.top;
    vp.x = px - ((px - vp.x) / vp.zoom) * zoom;
    vp.y = py - ((py - vp.y) / vp.zoom) * zoom;
    vp.zoom = zoom;
    this.applyViewport(); this.saveSoon();
  }

  zoomBy(f) { const r = this.stage.getBoundingClientRect(); this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, this.doc.viewport.zoom * f); }

  fit() {
    const ns = this.doc?.nodes || [];
    if (!ns.length) return;
    const minX = Math.min(...ns.map((n) => n.x)); const minY = Math.min(...ns.map((n) => n.y));
    const maxX = Math.max(...ns.map((n) => n.x + n.w)); const maxY = Math.max(...ns.map((n) => n.y + n.h));
    const r = this.stage.getBoundingClientRect();
    const zoom = Math.min(1, Math.max(0.2, Math.min((r.width - 120) / (maxX - minX), (r.height - 160) / (maxY - minY))));
    this.doc.viewport = { zoom, x: (r.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (r.height - 70 - (maxY - minY) * zoom) / 2 - minY * zoom };
    this.applyViewport(); this.saveSoon();
  }

  // Giữ zoom, đưa điểm (toạ độ thế giới) vào giữa khung.
  centerOn(wx, wy) {
    const r = this.stage.getBoundingClientRect();
    const vp = this.doc.viewport;
    vp.x = r.width / 2 - wx * vp.zoom; vp.y = r.height / 2 - wy * vp.zoom;
    this.applyViewport();
  }

  // ─── Bản đồ nhỏ ─────────────────────────────────────────────────────────
  // Góc dưới phải, trên thanh zoom: mọi node + khung đang nhìn. Bấm/kéo trên bản đồ → đưa chỗ đó
  // vào giữa khung. Khung nhìn góp vào bounds nên khi đang kéo phải giữ nguyên tỉ lệ cũ, không
  // thì bản đồ co giãn theo tay kéo. Bật/tắt bằng nút ở thanh zoom, nhớ qua localStorage.
  bindMinimap() {
    this.mm = $('#minimap');
    this.mmSvg = this.mm.querySelector('svg');
    this.mmOn = localStorage.getItem('menorah.minimap') !== '0';
    const btn = $('#minimap-toggle');
    btn.classList.toggle('on', this.mmOn);
    btn.addEventListener('click', () => {
      this.mmOn = !this.mmOn;
      localStorage.setItem('menorah.minimap', this.mmOn ? '1' : '0');
      btn.classList.toggle('on', this.mmOn);
      this.drawMinimap();
    });
    this.mm.addEventListener('pointerdown', (e) => {
      if (!this.doc || !this.mmMap || e.button !== 0) return;
      e.preventDefault();
      this.mm.setPointerCapture(e.pointerId);
      this.mmDrag = true;
      const { s, x0, y0 } = this.mmMap;
      const go = (ev) => { const r = this.mmSvg.getBoundingClientRect(); this.centerOn(x0 + (ev.clientX - r.left) / s, y0 + (ev.clientY - r.top) / s); };
      const up = () => { this.mm.removeEventListener('pointermove', go); this.mmDrag = false; this.drawMinimap(); this.saveSoon(); };
      go(e);
      this.mm.addEventListener('pointermove', go);
      this.mm.addEventListener('pointerup', up, { once: true });
      this.mm.addEventListener('pointercancel', up, { once: true });
    });
    window.addEventListener('resize', () => this.drawMinimapSoon());
  }

  drawMinimapSoon() { if (!this.mmRaf) this.mmRaf = requestAnimationFrame(() => { this.mmRaf = 0; this.drawMinimap(); }); }

  drawMinimap() {
    const ns = this.doc?.nodes || [];
    this.mm.hidden = !this.mmOn || !ns.length;
    if (this.mm.hidden) return;
    const W = this.mmSvg.clientWidth; const H = this.mmSvg.clientHeight; const pad = 10;
    const r = this.stage.getBoundingClientRect();
    const { x, y, zoom } = this.doc.viewport;
    const view = { x: -x / zoom, y: -y / zoom, w: r.width / zoom, h: r.height / zoom };
    if (!this.mmDrag || !this.mmMap) {
      const bs = [...ns, view];
      const minX = Math.min(...bs.map((b) => b.x)); const minY = Math.min(...bs.map((b) => b.y));
      const bw = Math.max(...bs.map((b) => b.x + b.w)) - minX; const bh = Math.max(...bs.map((b) => b.y + b.h)) - minY;
      const s = Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh);
      this.mmMap = { s, x0: minX - (W / s - bw) / 2, y0: minY - (H / s - bh) / 2 };
    }
    const { s, x0, y0 } = this.mmMap;
    const rect = (b, cls, rx) => `<rect class="${cls}" rx="${rx}" x="${((b.x - x0) * s).toFixed(1)}" y="${((b.y - y0) * s).toFixed(1)}" width="${Math.max(2, b.w * s).toFixed(1)}" height="${Math.max(2, b.h * s).toFixed(1)}"`;
    const cls = (n) => ['mm-n', n.kind === 'terminal' ? this.views.get(n.id)?.status || '' : n.kind, n.id === this.active ? 'on' : ''].join(' ');
    this.mmSvg.innerHTML = ns.map((n) => `${rect(n, cls(n), 2)}><title>${esc(n.title)}</title></rect>`).join('')
      + `${rect(view, 'mm-view', 3)}/>`;
  }

  // Về 100% và đưa node vào giữa — chỗ duy nhất chọn chữ trong terminal chính xác.
  focusNode(id, { zoom = 1 } = {}) {
    const n = this.node(id);
    if (!n) return;
    const r = this.stage.getBoundingClientRect();
    this.doc.viewport = { zoom, x: r.width / 2 - (n.x + n.w / 2) * zoom, y: (r.height - 60) / 2 - (n.y + n.h / 2) * zoom };
    this.applyViewport(); this.saveSoon();
    this.activate(id, true);
  }

  // ─── Sự kiện trên nền ───────────────────────────────────────────────────
  bindStage() {
    const st = this.stage;
    st.addEventListener('wheel', (e) => {
      if (!this.doc) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault(); e.stopPropagation();
        this.zoomAt(e.clientX, e.clientY, this.doc.viewport.zoom * Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.0025)));
        return;
      }
      const nodeEl = e.target.closest?.('.node');
      if (nodeEl && nodeEl.dataset.id === this.active && !nodeEl.classList.contains('image') && e.target.closest('.node-body')) return;   // node tự cuộn
      e.preventDefault(); e.stopPropagation();
      this.doc.viewport.x -= e.deltaX; this.doc.viewport.y -= e.deltaY;
      this.applyViewport(); this.saveSoon();
    }, { capture: true, passive: false });

    st.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.node') || e.target.closest('#links g') || e.button !== 0 && e.button !== 1) return;
      this.activate(null);
      this.selectLink(null);
      const sx = e.clientX; const sy = e.clientY; const { x, y } = this.doc.viewport;
      st.setPointerCapture(e.pointerId); st.classList.add('panning');
      const move = (ev) => { this.doc.viewport.x = x + ev.clientX - sx; this.doc.viewport.y = y + ev.clientY - sy; this.applyViewport(); };
      const up = () => { st.removeEventListener('pointermove', move); st.classList.remove('panning'); this.saveSoon(); };
      st.addEventListener('pointermove', move);
      st.addEventListener('pointerup', up, { once: true });
      st.addEventListener('pointercancel', up, { once: true });
    });

    // Chuột phải trên nền → app mở menu tạo node tại điểm đó (toạ độ world). Trên node để mặc định.
    st.addEventListener('contextmenu', (e) => {
      if (!this.doc || e.target.closest('.node') || e.target.closest('#links g')) return;
      e.preventDefault();
      this.onContextMenu(e, this.toWorld(e.clientX, e.clientY));
    });

    // Kéo thả tệp: lên node → gửi đường dẫn; lên nền → ảnh thành node ảnh.
    let dropEl = null;
    const mark = (el) => { if (dropEl !== el) { dropEl?.classList.remove('drop'); dropEl = el; el?.classList.add('drop'); } };
    st.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; mark(e.target.closest?.('.node.terminal, .node.note')); });
    st.addEventListener('dragleave', (e) => { if (!st.contains(e.relatedTarget)) mark(null); });
    st.addEventListener('drop', async (e) => {
      e.preventDefault(); mark(null);
      if (!this.doc) return;
      const nodeEl = e.target.closest?.('.node');
      const paths = await droppedPaths(e.dataTransfer);
      if (!paths.length) return;
      const v = nodeEl && this.views.get(nodeEl.dataset.id);
      if (v?.acceptPaths) { v.acceptPaths(paths); this.activate(v.n.id, true); return; }
      const pos = this.toWorld(e.clientX, e.clientY);
      const imgs = paths.filter(isImage);
      imgs.forEach((p, i) => this.addImage(p, { x: e.clientX, y: e.clientY }, i));
      if (imgs.length < paths.length) toast('Drop files onto a terminal to hand their paths to the agent.');
    });

    // Dán ảnh lên nền (⌘V khi không gõ trong terminal / ô nhập): tệp ảnh đã copy (Finder) hoặc
    // ảnh trong clipboard (ảnh chụp, ảnh copy từ trình duyệt) → node ảnh tại con trỏ.
    st.addEventListener('pointermove', (e) => { this.pointer = { x: e.clientX, y: e.clientY }; });
    st.addEventListener('pointerleave', () => { this.pointer = null; });
    document.addEventListener('paste', async (e) => {
      if (!this.doc || !this.stage.offsetParent || e.defaultPrevented) return;
      const t = document.activeElement;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || t.closest('.node.terminal, .modal, dialog'))) return;
      e.preventDefault();
      const at = this.pointer;
      let paths = (await droppedPaths(e.clipboardData)).filter(isImage);
      if (!paths.length && !e.clipboardData.types.includes('text/plain')) {
        const p = await window.menorah.clipboardImage();
        if (p) paths = [p];
      }
      if (!paths.length) { toast('The clipboard has no image to paste onto the canvas.'); return; }
      paths.forEach((p, i) => this.addImage(p, at, i));
    });

    document.addEventListener('keydown', (e) => {
      if (document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selLink) { this.removeLink(this.selLink); e.preventDefault(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && this.node(this.active)?.kind === 'image' && this.stage.offsetParent) { this.remove(this.active); e.preventDefault(); }
      if (e.key === 'Escape') { this.selectLink(null); }
    });
  }

  // ─── Node ───────────────────────────────────────────────────────────────
  add(spec) {
    const kind = spec.kind || 'terminal';
    const [w, hgt] = DEFAULT_SIZE[kind];
    const r = this.stage.getBoundingClientRect();
    const c = this.toWorld(r.left + r.width / 2, r.top + (r.height - 60) / 2);
    let x = spec.x ?? Math.round(c.x - w / 2); let y = spec.y ?? Math.round(c.y - hgt / 2);
    while (this.doc.nodes.some((n) => Math.abs(n.x - x) < 8 && Math.abs(n.y - y) < 8)) { x += 32; y += 32; }
    const n = {
      id: `${kind === 'terminal' ? 'term' : kind}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
      kind, x, y, w, h: hgt, title: spec.title || (kind === 'terminal' ? AGENTS[spec.agent || 'shell'].label : kind === 'note' ? 'Note' : 'Image'),
      titleAuto: !spec.title,
      ...(kind === 'terminal' && { agent: spec.agent || 'shell', cwd: spec.cwd || this.rootCwd(), sessionId: spec.agent === 'claude' ? crypto.randomUUID() : null, view: 'cli' }),
      ...(kind === 'note' && { text: spec.text || '' }),
      ...(kind === 'image' && { path: spec.path }),
    };
    this.doc.nodes.push(n);
    this.mount(n, { start: kind === 'terminal' });
    this.changed();
    this.activate(n.id, true);
    return n;
  }

  // Node ảnh căn giữa tại điểm màn hình `at` (không có thì giữa khung nhìn); ImageView chỉnh lại
  // khung theo tỉ lệ ảnh khi ảnh nạp xong, vẫn giữ tâm.
  addImage(path, at, i = 0) {
    const [w, hgt] = DEFAULT_SIZE.image;
    const spec = { kind: 'image', path, title: path.split(/[\\/]/).pop() };
    if (at) { const p = this.toWorld(at.x, at.y); spec.x = Math.round(p.x - w / 2 + i * 24); spec.y = Math.round(p.y - hgt / 2 + i * 24); }
    return this.add(spec);
  }

  mount(n, opts = {}) {
    const View = n.kind === 'terminal' ? TerminalView : n.kind === 'note' ? NoteView : ImageView;
    const v = new View(this, n, opts);
    this.views.set(n.id, v);
    this.nodesEl.append(v.el);
    v.el.style.zIndex = ++this.z;
    this.place(n);
    v.mounted?.();
    return v;
  }

  place(n) {
    const v = this.views.get(n.id);
    if (!v) return;
    Object.assign(v.el.style, { left: `${n.x}px`, top: `${n.y}px`, width: `${n.w}px`, height: `${n.h}px` });
    this.drawMinimapSoon();
  }

  activate(id, focus) {
    if (this.active && this.active !== id) this.views.get(this.active)?.el.classList.remove('active');
    this.active = id;
    this.drawMinimapSoon();
    const v = id && this.views.get(id);
    if (!v) { if (document.activeElement?.closest?.('.node')) document.activeElement.blur(); return; }
    v.el.classList.add('active');
    if (Number(v.el.style.zIndex) !== this.z) v.el.style.zIndex = ++this.z;
    if (focus) v.focus?.();
  }

  async remove(id) {
    const v = this.views.get(id);
    if (!v) return;
    if (v.n.kind === 'terminal' && !v.stopped) {
      const ok = await confirmBox('Close this node?', `The running ${AGENTS[v.n.agent].label} session will be stopped. Claude Code and Codex keep their history — resume with claude --resume / codex resume.`, 'Stop and close', true);
      if (!ok) return;
    }
    v.dispose();
    this.views.delete(id);
    this.doc.nodes = this.doc.nodes.filter((n) => n.id !== id);
    this.doc.links = this.doc.links.filter((l) => l.from !== id && l.to !== id);
    if (this.active === id) this.active = null;
    this.drawLinks(); this.changed();
  }

  // Kéo tiêu đề để di chuyển, kéo cạnh/góc để đổi cỡ.
  // Node ảnh thả lên terminal / ghi chú → gửi đường dẫn ảnh cho node đó, ảnh về chỗ cũ.
  dragMove(e, n) {
    const sx = e.clientX; const sy = e.clientY; const ox = n.x; const oy = n.y; const z = this.doc.viewport.zoom;
    const t = e.currentTarget; t.setPointerCapture(e.pointerId);
    const self = this.views.get(n.id)?.el;
    let target = null;
    const aim = (el) => { if (target !== el) { target?.classList.remove('drop'); target = el; target?.classList.add('drop'); self?.classList.toggle('handing', !!el); } };
    const move = (ev) => {
      n.x = Math.round(ox + (ev.clientX - sx) / z); n.y = Math.round(oy + (ev.clientY - sy) / z); this.place(n); this.drawLinks();
      if (n.kind === 'image') aim(document.elementsFromPoint(ev.clientX, ev.clientY).map((el) => el.closest('.node')).find((el) => el && el !== self && el.matches('.terminal, .note')) || null);
    };
    t.addEventListener('pointermove', move);
    t.addEventListener('pointerup', () => {
      t.removeEventListener('pointermove', move);
      const v = target && this.views.get(target.dataset.id);
      aim(null);
      if (v?.acceptPaths) { n.x = ox; n.y = oy; this.place(n); this.drawLinks(); v.acceptPaths([n.path]); this.activate(v.n.id, true); return; }
      this.changed();
    }, { once: true });
  }

  dragResize(e, n, dir) {
    e.stopPropagation();
    const sx = e.clientX; const sy = e.clientY; const o = { ...n }; const z = this.doc.viewport.zoom;
    const [mw, mh] = MIN[n.kind];
    const t = e.currentTarget; t.setPointerCapture(e.pointerId);
    let raf = 0;
    const move = (ev) => {
      const dx = (ev.clientX - sx) / z; const dy = (ev.clientY - sy) / z;
      // Ảnh: giữ tỉ lệ như Figma, giữ ⇧ để kéo tự do. Kéo cạnh thì cạnh kia theo tỉ lệ.
      if (n.kind === 'image' && n.ar && !ev.shiftKey) {
        const sw = dir.includes('e') ? o.w + dx : dir.includes('w') ? o.w - dx : 0;
        const sh = dir.includes('s') ? o.h + dy : dir.includes('n') ? o.h - dy : 0;
        n.w = Math.max(mw, Math.round(Math.max(sw, sh * n.ar))); n.h = Math.max(mh, Math.round(n.w / n.ar));
        n.x = dir.includes('w') ? o.x + o.w - n.w : o.x;
        n.y = dir.includes('n') ? o.y + o.h - n.h : o.y;
        this.place(n); this.drawLinks();
        return;
      }
      if (dir.includes('e')) n.w = Math.max(mw, Math.round(o.w + dx));
      if (dir.includes('s')) n.h = Math.max(mh, Math.round(o.h + dy));
      if (dir.includes('w')) { n.w = Math.max(mw, Math.round(o.w - dx)); n.x = o.x + o.w - n.w; }
      if (dir.includes('n')) { n.h = Math.max(mh, Math.round(o.h - dy)); n.y = o.y + o.h - n.h; }
      this.place(n); this.drawLinks();
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.views.get(n.id)?.fit?.(); });
    };
    t.addEventListener('pointermove', move);
    t.addEventListener('pointerup', () => { t.removeEventListener('pointermove', move); this.views.get(n.id)?.fit?.(); this.changed(); }, { once: true });
  }

  // ─── Dây nối ────────────────────────────────────────────────────────────
  dragLink(e, n) {
    e.stopPropagation(); e.preventDefault();
    const t = e.currentTarget; t.setPointerCapture(e.pointerId);
    const temp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    temp.setAttribute('class', 'temp');
    this.svg.append(temp);
    let target = null;
    const from = { x: n.x + n.w, y: n.y + 17 };
    const move = (ev) => {
      const p = this.toWorld(ev.clientX, ev.clientY);
      temp.setAttribute('d', this.curve(from, p));
      const el = document.elementsFromPoint(ev.clientX, ev.clientY).map((x) => x.closest?.('.node')).find((x) => x && x.dataset.id !== n.id) || null;
      if (el !== target) { target?.classList.remove('link-target'); target = el; target?.classList.add('link-target'); }
    };
    t.addEventListener('pointermove', move);
    t.addEventListener('pointerup', () => {
      t.removeEventListener('pointermove', move); temp.remove(); target?.classList.remove('link-target');
      if (target) this.link(n.id, target.dataset.id);
    }, { once: true });
  }

  link(a, b) {
    if (a === b || this.doc.links.some((l) => (l.from === a && l.to === b) || (l.from === b && l.to === a))) return;
    this.doc.links.push({ id: `link-${Date.now().toString(36)}`, from: a, to: b });
    this.drawLinks(); this.changed();
    const A = this.node(a); const B = this.node(b);
    const agentSide = [A, B].find((x) => x.kind === 'terminal' && x.agent !== 'shell');
    const other = agentSide === A ? B : A;
    toast(agentSide ? `Linked. Tell ${AGENTS[agentSide.agent].label}: “read the context of node ${other.title}” — it uses the menorah-context command.` : 'Nodes linked.', 5200);
  }

  removeLink(id) {
    this.doc.links = this.doc.links.filter((l) => l.id !== id);
    this.selLink = null; this.drawLinks(); this.changed();
  }

  selectLink(id) { this.selLink = id; this.drawLinks(); }

  curve(a, b) {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    const sa = b.x >= a.x ? 1 : -1;
    return `M${a.x},${a.y} C${a.x + dx * sa},${a.y} ${b.x - dx * sa},${b.y} ${b.x},${b.y}`;
  }

  anchors(A, B) {
    const ac = { x: A.x + A.w / 2, y: A.y + A.h / 2 }; const bc = { x: B.x + B.w / 2, y: B.y + B.h / 2 };
    if (B.x > A.x + A.w) return [{ x: A.x + A.w, y: ac.y }, { x: B.x, y: bc.y }];
    if (A.x > B.x + B.w) return [{ x: A.x, y: ac.y }, { x: B.x + B.w, y: bc.y }];
    return bc.y > ac.y ? [{ x: ac.x, y: A.y + A.h }, { x: bc.x, y: B.y }] : [{ x: ac.x, y: A.y }, { x: bc.x, y: B.y + B.h }];
  }

  drawLinks() {
    if (!this.doc) return;
    const svg = this.svg;
    svg.querySelectorAll('g').forEach((g) => g.remove());
    const linked = new Set();
    for (const l of this.doc.links) {
      const A = this.node(l.from); const B = this.node(l.to);
      if (!A || !B) continue;
      linked.add(A.id); linked.add(B.id);
      const [a, b] = this.anchors(A, B);
      const vertical = Math.abs(a.x - b.x) < Math.abs(a.y - b.y) && (a.x === A.x + A.w / 2);
      const d = vertical ? `M${a.x},${a.y} C${a.x},${(a.y + b.y) / 2} ${b.x},${(a.y + b.y) / 2} ${b.x},${b.y}` : this.curve(a, b);
      // Mũi tên chỉ vào node đọc được context: terminal nào cũng chạy được menorah-context,
      // note / ảnh thì không. Dây hai chiều — hai terminal nối nhau thì đọc được của nhau.
      const aReads = A.kind === 'terminal'; const bReads = B.kind === 'terminal';
      const mk = this.selLink === l.id ? 'url(#arrow-sel)' : 'url(#arrow)';
      const tip = [aReads && `${A.title} reads context from ${B.title}`, bReads && `${B.title} reads context from ${A.title}`].filter(Boolean).join('\n')
        || `${A.title} — ${B.title}: neither can read the other (only terminals can)`;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.innerHTML = `<title>${esc(tip)}</title><path class="hit" d="${d}"/><path class="rope" d="${d}"${aReads ? ` marker-start="${mk}"` : ''}${bReads ? ` marker-end="${mk}"` : ''}/>`;
      if (this.selLink === l.id) {
        g.classList.add('sel');
        const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
        g.insertAdjacentHTML('beforeend', `<g class="rope-x" transform="translate(${mx},${my})"><title>Remove link</title><circle r="10"/><path d="M-4,-4 L4,4 M4,-4 L-4,4"/></g>`);
        g.querySelector('.rope-x').addEventListener('pointerdown', (e) => { e.stopPropagation(); this.removeLink(l.id); });
      }
      g.querySelector('.hit').addEventListener('pointerdown', (e) => { e.stopPropagation(); this.selectLink(l.id); });
      svg.append(g);
    }
    for (const v of this.views.values()) v.port?.classList.toggle('has', linked.has(v.n.id));
  }

  // ─── Trạng thái ─────────────────────────────────────────────────────────
  async pollStatus() {
    if (!this.doc) return;
    const ids = this.doc.nodes.filter((n) => n.kind === 'terminal').map((n) => n.id);
    if (!ids.length) return this.onStatus({});
    let st;
    try { st = await window.menorah.ptyState(ids); } catch { return; }
    for (const [id, s] of Object.entries(st)) this.views.get(id)?.setStatus(s);
    this.drawMinimapSoon();
    this.onStatus(st);
  }

  // Sub agent của các node Claude: chỉ hỏi cho node đã có session id.
  async pollSubagents() {
    if (!this.doc || document.hidden) return;
    const list = this.doc.nodes.filter((n) => n.kind === 'terminal' && n.agent === 'claude' && n.sessionId).map((n) => ({ nodeId: n.id, sessionId: n.sessionId }));
    if (!list.length) return;
    let r;
    try { r = await window.menorah.subagents(list); } catch { return; }
    for (const [id, subs] of Object.entries(r)) this.views.get(id)?.setSubagents?.(subs);
  }

  // Mốc prompt cache của các phiên Claude đang mở (agentd đọc transcript, như tai thỏ).
  async pollCache() {
    if (!this.doc || document.hidden || !this.doc.nodes.some((n) => n.kind === 'terminal' && n.agent === 'claude')) return;
    let list;
    try { list = await window.menorah.cache(); } catch { return; }
    const by = new Map(list.map((x) => [x.nodeId, x]));
    for (const v of this.views.values()) v.setCache?.(by.get(v.n.id));
  }

  resumeAll() { for (const v of this.views.values()) if (v.stopped && v.n.kind === 'terminal') v.start(); }
}

// ─── Khung chung của một node ───────────────────────────────────────────────
class NodeView {
  constructor(canvas, n) {
    this.c = canvas; this.n = n;
    this.titleEl = h('div.node-title', { title: 'Double-click to rename' }, n.title);
    this.head = h('div.node-head');
    this.body = h('div.node-body');
    this.el = h(`div.node.${n.kind}`, { dataset: { id: n.id } }, this.head, this.body,
      ...['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => h(`div.resize.${d}`, { onpointerdown: (e) => this.c.dragResize(e, this.n, d) })));
    this.el.addEventListener('pointerdown', () => this.c.activate(this.n.id, false), true);
    this.head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, input, .port, .mode')) return;
      this.c.dragMove(e, this.n);
    });
    this.head.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, input, .port, .mode')) return;
      if (this.onTitleText(e)) this.rename(); else this.c.focusNode(this.n.id);
    });
    this.port = h('span.port', { title: 'Drag onto another node to link context', onpointerdown: (e) => this.c.dragLink(e, this.n) });
  }

  headButtons() {
    return [
      this.port,
      h('button.node-btn', { title: 'Zoom to 100% and center (or double-click an empty spot of the title bar)', onclick: () => this.c.focusNode(this.n.id) }, icon('focus')),
      h('button.node-btn.close', { title: 'Close node', onclick: () => this.c.remove(this.n.id) }, icon('close')),
    ];
  }

  // Header bắt chuột khi bấm xuống (để kéo node) nên dblclick luôn trỏ vào header, không phải
  // tiêu đề; đo theo toạ độ. Tiêu đề giãn hết chỗ trống, nên chỉ tính phần có chữ.
  onTitleText(e) {
    if (this.titleEl.querySelector('input')) return false;
    const r = document.createRange();
    r.selectNodeContents(this.titleEl);
    const t = r.getBoundingClientRect(), box = this.titleEl.getBoundingClientRect();
    return e.clientX >= box.left && e.clientX <= Math.min(box.right, t.right + 8) && e.clientY >= box.top && e.clientY <= box.bottom;
  }

  rename() {
    const inp = h('input', { type: 'text', value: this.n.title, maxlength: 80 });
    this.titleEl.replaceChildren(inp);
    inp.focus(); inp.select();
    let closed = false;
    const done = (ok) => {
      if (closed) return;
      closed = true; // Gỡ ô nhập làm blur chạy lại done: Esc phải giữ nguyên tên cũ.
      const v = inp.value.trim();
      if (ok && v && v !== this.n.title) { this.n.title = v; this.n.titleAuto = false; this.c.changed(); }
      this.titleEl.textContent = this.n.title;
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true), { once: true });
  }

  setStatus() {}
  dispose() { this.el.remove(); }
}

// ─── Terminal / agent ───────────────────────────────────────────────────────
class TerminalView extends NodeView {
  constructor(canvas, n, opts) {
    super(canvas, n);
    this.stopped = true;
    this.status = 'stopped';
    this.dot = h('span.status-dot');
    const isAgent = n.agent !== 'shell';
    this.modeBtns = isAgent ? ['cli', 'chat'].map((m) => h('button', { onclick: () => this.setView(m) }, m === 'cli' ? 'CLI' : 'Chat')) : [];
    const rel = this.relCwd();
    this.head.append(...[
      h(`span.agent-mark.${n.agent}`, AGENTS[n.agent].mark), this.dot, this.titleEl,
      rel ? h('span.node-cwd', { title: n.cwd }, rel) : null,
      n.agent === 'claude' ? (this.cacheEl = h('button.cache-chip', { hidden: true, onclick: () => this.compact() }, icon('clock'), this.cacheTxt = h('span'))) : null,
      isAgent ? h('div.mode', this.modeBtns) : null,
      ...this.headButtons(),
    ].filter(Boolean));
    this.host = h('div.term-host');
    this.overlay = h('div.overlay', { hidden: true });
    this.body.append(this.host, this.overlay);
    this.subEl = h('div.subagents', { hidden: true });
    this.body.after(this.subEl);
    // Thân node đổi cỡ (kéo góc, dải sub agent hiện/ẩn/mở) → xterm tính lại số cột/dòng.
    let raf = 0;
    this.ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => this.fit()); });
    this.ro.observe(this.body);

    this.term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace', fontSize: 13, lineHeight: 1.15,
      cursorBlink: true, allowProposedApi: true, scrollback: 10000, theme: XTERM_THEME, macOptionIsMeta: false,
      macOptionClickForcesSelection: true, rightClickSelectsWord: false, drawBoldTextInBrightColors: true,
    });
    this.fitAddon = new FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);
    try { this.term.loadAddon(new Unicode11Addon.Unicode11Addon()); this.term.unicode.activeVersion = '11'; } catch {}
    try { this.term.loadAddon(new WebLinksAddon.WebLinksAddon((e, url) => window.open(url))); } catch {}
    this.term.onData((d) => { if (!this.stopped) window.menorah.ptyWrite(n.id, d); });
    this.term.onResize(({ cols, rows }) => { if (!this.stopped) window.menorah.ptyResize(n.id, cols, rows); });

    // Dán tệp / ảnh: tệp đã copy (Finder, "Copy Media" của Telegram…) → đường dẫn của nó; ảnh
    // không có tệp (ảnh chụp, Copy Image) → lưu vào uploads/ rồi gửi đường dẫn. Clipboard có chữ
    // mà không có tệp thật (Word kèm ảnh xem trước…) thì để xterm dán chữ như thường.
    this.body.addEventListener('paste', async (e) => {
      const dt = e.clipboardData;
      const real = [...dt.files].some((f) => window.menorah.pathOf(f));
      if (dt.types.includes('text/plain') && !real) return;
      e.preventDefault(); e.stopPropagation();
      let paths = await droppedPaths(dt);
      if (!paths.length) { const p = await window.menorah.clipboardImage(); if (p) paths = [p]; }
      if (paths.length) this.acceptPaths(paths); else toast('The clipboard has no image or text.');
    }, true);

    this.wantStart = opts.start || opts.running;
    if (isAgent && n.view === 'chat') this.pendingView = 'chat';
  }

  relCwd() {
    const root = this.c.rootCwd();
    if (!this.n.cwd || this.n.cwd === root) return '';
    return this.n.cwd.startsWith(root) ? this.n.cwd.slice(root.length + 1) : this.n.cwd.split(/[\\/]/).slice(-2).join('/');
  }

  mounted() {
    this.term.open(this.host);
    this.unscaleMouse();
    this.fit();
    if (this.wantStart) this.start();
    else this.showStopped();
    this.setView(this.pendingView || 'cli', true);
  }

  // xterm đổi chuột ra ô bằng (clientX − rect.left) / cỡ ô: khoảng cách đo trên màn hình (đã
  // scale theo zoom canvas) chia cỡ ô chưa scale → zoom ≠ 100% thì chọn chữ, hover và bấm
  // (Claude Code bật mouse tracking) lệch dòng. Đưa toạ độ về khung chưa scale trước khi xterm
  // tính. Tỉ lệ đo thẳng từ phần tử nên đúng cả khi node đang phóng to toàn khung.
  unscaleMouse() {
    const ms = this.term._core?._mouseService;
    if (!ms) return;
    const fix = (e, el) => {
      const r = el.getBoundingClientRect(), s = el.offsetWidth ? r.width / el.offsetWidth : 1;
      return Math.abs(s - 1) < 1e-3 ? e : { clientX: r.left + (e.clientX - r.left) / s, clientY: r.top + (e.clientY - r.top) / s };
    };
    const coords = ms.getCoords.bind(ms), report = ms.getMouseReportCoords.bind(ms);
    ms.getCoords = (e, el, ...rest) => coords(fix(e, el), el, ...rest);
    ms.getMouseReportCoords = (e, el) => report(fix(e, el), el);
  }

  fit() {
    if (!this.host.offsetWidth || this.n.view === 'chat' && !this.term.element?.offsetParent) return;
    try { this.fitAddon.fit(); } catch {}
  }

  async start() {
    this.overlay.hidden = true;
    this.fit();
    let r;
    try {
      r = await window.menorah.ptyStart({ nodeId: this.n.id, agent: this.n.agent, cwd: this.n.cwd, sessionId: this.n.sessionId, cols: this.term.cols, rows: this.term.rows });
    } catch (e) {
      this.overlay.hidden = false;
      this.overlay.replaceChildren(h('div', h('p', `Could not open the terminal: ${e.message}`)));
      return;
    }
    this.stopped = false;
    this.term.reset();
    if (r.buffer) this.term.write(r.buffer);
    if (r.sessionId && r.sessionId !== this.n.sessionId) { this.n.sessionId = r.sessionId; this.c.saveSoon(); }
    this.setStatus('idle');
    this.c.refreshResume();
    if (this.c.active === this.n.id) this.focus();
  }

  showStopped(code) {
    this.stopped = true;
    this.setStatus(code == null ? 'stopped' : 'exited');
    const resumable = this.n.agent === 'claude' || (this.n.agent === 'codex' && this.n.sessionId);
    this.overlay.replaceChildren(h('div',
      h('p', code == null ? (resumable ? 'Session stopped. Resume to continue the same conversation.' : 'Terminal stopped.') : `Session ended (exit code ${code}).`),
      h('button.primary', { onclick: () => this.start() }, icon('play'), resumable ? 'Resume session' : 'Restart')));
    this.overlay.hidden = false;
    this.c.refreshResume();
  }

  exited(code) { this.showStopped(code); }

  setStatus(s) {
    if (this.stopped && s !== 'stopped' && s !== 'exited') s = 'stopped';
    this.status = s;
    this.dot.className = `status-dot ${s === 'stopped' ? '' : s}`;
    this.dot.title = { running: 'Running', idle: 'Waiting', stopped: 'Stopped', exited: 'Exited' }[s] || '';
    this.chat?.setState(s);
    this.tickCache();
  }

  // ─── Prompt cache (chỉ Claude) ──────────────────────────────────────────
  // Cache sống cacheTtl giây kể từ request cuối; qua mốc đó prompt kế tiếp ghi lại cả context.
  setCache(x) {
    this.cache = x && x.cacheAt && !x.compacted ? { end: x.cacheAt + (x.cacheTtl || 3600) * 1e3, ttl: x.cacheTtl || 3600 } : null;
    this.tickCache();
  }

  tickCache() {
    const el = this.cacheEl;
    if (!el) return;
    // Đang chạy thì cache liên tục được làm mới — đếm ngược lúc đó vô nghĩa.
    if (!this.cache || this.status !== 'idle') { el.hidden = true; return; }
    const left = this.cache.end - Date.now(), lead = Math.min(5 * 60e3, this.cache.ttl * 1e3 / 5);
    const st = left <= 0 ? 'cold' : left <= lead ? 'soon' : 'warm';
    const sec = Math.max(0, Math.ceil(left / 1000));
    el.hidden = false;
    el.className = `cache-chip ${st}`;
    this.cacheTxt.textContent = st === 'cold' ? 'cold' : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    el.title = st === 'cold'
      ? 'Prompt cache expired — the next prompt re-sends the whole context.\nClick to run /compact so later prompts start from a short summary.'
      : `Prompt cache stays warm for ${Math.ceil(sec / 60)} more min.\nClick to run /compact now — cheapest while the cache is warm, and you can pick up later from the summary.`;
  }

  compact() {
    if (this.stopped) return toast('The session is stopped — click Resume session first.');
    if (this.status !== 'idle') return toast('Claude is busy — wait for it to finish, then compact.');
    window.menorah.ptyWrite(this.n.id, '\x1b[200~/compact\x1b[201~');
    setTimeout(() => window.menorah.ptyWrite(this.n.id, '\r'), 80);
    this.cache = null;
    this.tickCache();
    this.focus();
  }

  setView(mode, initial) {
    if (this.n.agent === 'shell') mode = 'cli';
    this.modeBtns.forEach((b, i) => b.classList.toggle('on', (i === 0) === (mode === 'cli')));
    if (mode === 'chat') {
      if (!this.chat) {
        this.chat = new ChatView(this.n, { write: (d) => { if (this.stopped) toast('The session is stopped — click Resume session first.'); else window.menorah.ptyWrite(this.n.id, d); }, onFocus: () => this.c.activate(this.n.id), isWin: this.c.info.platform === 'win32' });
        this.body.append(this.chat.el);
      }
      this.chat.el.hidden = false;
      this.chat.setState(this.status);
      this.chat.start();
    } else {
      if (this.chat) { this.chat.stop(); this.chat.el.hidden = true; }
      requestAnimationFrame(() => { this.fit(); if (!initial) this.focus(); });
    }
    if (this.n.view !== mode) { this.n.view = mode; if (!initial) this.c.saveSoon(); }
  }

  focus() { if (this.n.view === 'chat' && this.chat) this.chat.input.focus(); else this.term.focus(); }

  // Dải sub agent dưới thân node: thu gọn là một dòng đếm, mở ra là danh sách từng sub agent
  // (loại, mô tả, bước gần nhất, số bước · thời gian · token).
  setSubagents(subs) {
    const key = JSON.stringify(subs.map((a) => [a.id, a.state, a.steps, a.tool]));
    this.subs = subs;
    this.el.classList.toggle('has-subs', subs.length > 0);
    if (!subs.length) { this.subEl.hidden = true; this.subKey = key; return; }
    this.subEl.hidden = false;
    if (key === this.subKey && !subs.some((a) => a.state === 'running')) return;
    this.subKey = key;
    const running = subs.filter((a) => a.state === 'running').length;
    const done = subs.filter((a) => a.state === 'done').length;
    const stalled = subs.length - running - done;
    const open = !!this.n.subOpen;
    const summary = [running && `${running} running`, done && `${done} done`, stalled && `${stalled} stalled`].filter(Boolean).join(' · ');
    const head = h('button.sub-head', { title: open ? 'Collapse' : 'Show each sub agent', onclick: () => { this.n.subOpen = !open; this.c.saveSoon(); this.subKey = null; this.setSubagents(this.subs); } },
      h(`span.chev${open ? '.open' : ''}`, '›'), h(`span.status-dot${running ? '.running' : ''}`), h('b', 'Sub agent'), h('span.muted', summary));
    // replaceChildren gốc đổi null thành chữ "null" — chỉ truyền nút có thật.
    this.subEl.replaceChildren(...[head, open && h('div.sub-list', subs.map((a) => this.subRow(a)))].filter(Boolean));
  }

  subRow(a) {
    const ms = (a.state === 'running' ? Date.now() : a.last) - a.start;
    const dur = !a.start ? '' : ms < 60e3 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60e3)} min`;
    const tok = a.tokens ? `${a.tokens >= 1000 ? `${(a.tokens / 1000).toFixed(1)}k` : a.tokens} token` : '';
    const label = { running: 'Running', done: 'Done', stopped: 'No longer active' }[a.state];
    return h(`div.sub-row.${a.state}`,
      h(`span.status-dot${a.state === 'running' ? '.running' : a.state === 'done' ? '.done' : ''}`, { title: label }),
      h('span.sub-type', a.type),
      h('span.sub-desc', { title: a.description }, a.description || '—'),
      h('span.sub-tool', { title: a.tool }, a.state === 'done' ? '' : a.tool),
      h('span.sub-meta', [`${a.steps} steps`, dur, tok].filter(Boolean).join(' · ')));
  }

  // Tệp kéo/dán vào: chế độ Chat thì thành tệp đính kèm, CLI thì dán đường dẫn vào terminal.
  acceptPaths(paths) {
    if (this.n.view === 'chat' && this.chat) return this.chat.attach(paths);
    if (this.stopped) return toast('The session is stopped — click Resume session first.');
    const text = paths.map((p) => quotePath(p, this.c.info.platform === 'win32')).join(' ');
    window.menorah.ptyWrite(this.n.id, `\x1b[200~${text} \x1b[201~`);
    this.term.focus();
  }

  dispose(keepSession) {
    this.ro.disconnect();
    this.chat?.stop();
    if (keepSession) window.menorah.ptyDetach(this.n.id); else window.menorah.ptyKill(this.n.id);
    this.term.dispose();
    super.dispose();
  }
}

// ─── Ghi chú ────────────────────────────────────────────────────────────────
class NoteView extends NodeView {
  constructor(canvas, n) {
    super(canvas, n);
    this.head.append(this.titleEl, ...this.headButtons());
    this.ta = h('textarea', { placeholder: 'Note… Link it to an agent so the agent can read it.' });
    this.ta.value = n.text || '';
    this.ta.addEventListener('input', () => { n.text = this.ta.value; this.c.saveSoon(); });
    this.ta.addEventListener('keydown', (e) => e.stopPropagation());
    this.body.append(this.ta);
  }
  focus() { this.ta.focus(); }
  acceptPaths(paths) { this.ta.value += (this.ta.value && !this.ta.value.endsWith('\n') ? '\n' : '') + paths.join('\n'); this.n.text = this.ta.value; this.c.saveSoon(); }
}

// ─── Ảnh ────────────────────────────────────────────────────────────────────
// Như Figma: kéo ảnh để di chuyển, kéo góc / cạnh để đổi cỡ giữ tỉ lệ (⇧ tự do), nhấp đúp ảnh
// để về đúng tỉ lệ, Delete để xoá. Tên và nút nằm phía trên ảnh, hiện khi rê chuột / chọn.
// Thả ảnh lên terminal hoặc ghi chú để gửi đường dẫn (Canvas.dragMove).
class ImageView extends NodeView {
  constructor(canvas, n) {
    super(canvas, n);
    this.head.append(this.titleEl, h('button.node-btn', { title: 'Show in Finder', onclick: () => window.menorah.reveal(n.path) }, icon('folder')), ...this.headButtons());
    const img = h('img', { draggable: false, alt: n.title, title: `${n.path}\nDrag onto a terminal to hand it to the agent · ⇧ while resizing to ignore the aspect ratio` });
    img.addEventListener('load', () => {
      const ar = img.naturalWidth / img.naturalHeight;
      if (!ar || n.ar) return;
      // Lần đầu: khung theo tỉ lệ ảnh, ngang tối đa 560, giữ tâm chỗ đã đặt.
      const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
      n.ar = ar; n.w = Math.max(MIN.image[0], Math.min(560, img.naturalWidth)); n.h = Math.round(n.w / ar);
      n.x = Math.round(cx - n.w / 2); n.y = Math.round(cy - n.h / 2);
      this.c.place(n); this.c.drawLinks(); this.c.changed();
    });
    window.menorah.thumb(n.path, 1600).then((u) => { if (u) img.src = u; else this.body.replaceChildren(h('p.muted', 'Could not read the image (deleted?)')); });
    this.body.addEventListener('pointerdown', (e) => { if (e.button === 0) this.c.dragMove(e, this.n); });
    this.body.addEventListener('dblclick', () => {
      if (!n.ar) return;
      n.h = Math.max(MIN.image[1], Math.round(n.w / n.ar)); this.c.place(n); this.c.drawLinks(); this.c.changed();
    });
    this.body.append(img);
  }
}
