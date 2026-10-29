// Khung Chat của một node agent. Không phải phiên riêng: đọc transcript của CHÍNH phiên đang
// chạy trong terminal (poll 1 giây khi đang mở), tin gõ ở ô soạn được dán thẳng vào terminal
// bằng bracketed paste rồi Enter — như người gõ. Chuyển CLI ↔ Chat không mất gì.
'use strict';

class ChatView {
  constructor(node, { write, resume, onFocus, isWin, onFiles, sizeKey, drop }) {
    this.node = node;               // doc node (agent, sessionId)
    this.write = write;             // (data) => gửi vào PTY
    this.resume = resume;           // (prompt) => mở lại phiên đã dừng rồi gửi prompt (Canvas.resumeSend)
    this.note = '';                 // việc app đang làm thay người dùng (Resuming…, Compacting…)
    this.onFiles = onFiles;         // ({ paths, latest, last }) sau mỗi lần vẽ: mọi tệp phiên đã sửa, tệp của lượt gần nhất có sửa, lần sửa xong gần nhất
    this.isWin = isWin;
    this.offset = 0;
    this.sessionId = null;
    this.msgs = [];
    this.attachments = [];
    this.sent = [];                 // prompt đã gửi trong lần mở này (transcript có thể chưa kịp ghi) — cho ↑ lật lại
    this.timer = null;
    this.open = new Set();          // bước đang mở (id tool) — giữ qua các lần vẽ lại
    this.openGroups = new Set();    // khối bước đã bấm "Show earlier steps"
    this.fullUser = new Set();      // tin người dùng đang mở hết (mặc định gọn 3 dòng)
    this.filesOpen = true;          // khung tệp đã sửa trên ô soạn

    this.log = h('div.chat-log');
    this.jump = h('button.chat-jump', { type: 'button', title: 'Jump to the latest message', hidden: true,
      onclick: () => this.toBottom() }, icon('chev'));
    this.filesEl = h('div.chat-files', { hidden: true });
    this.attEl = h('div.attachments');
    this.input = h('textarea', { rows: 1, placeholder: 'Message the agent — Shift+Enter for a new line, drop files or images', title: 'Enter to send · Shift+Enter for a new line · drop or paste files and images' });
    this.stateDot = h('span.status-dot');
    this.stateText = h('span');
    const key = (label, data, title) => h('button.chat-key', { type: 'button', title, onclick: () => { this.write(data); this.input.focus(); } }, label);
    this.el = h('div.chat', { onmousedown: onFocus },
      h('div.chat-scroll', this.log, this.jump),
      h('div.chat-foot',
        this.filesEl,
        this.composer = h('div.composer',
          sizeKey ? h('div.composer-rz', { title: 'Drag to make the message box taller · double-click to reset' }) : null,
          this.attEl,
          this.input,
          h('div.composer-bar',
            key('Esc', '\x1b', 'Interrupt / close the picker'), key('Enter', '\r', 'Confirm the highlighted choice'),
            key('1', '1', 'Pick option 1 (usually Yes)'), key('2', '2', 'Pick option 2'), key('3', '3', 'Pick option 3'),
            this.metaEl = h('span.chat-meta'), h('span.state', { title: 'Agent status' }, this.stateDot, this.stateText),
            h('button.chat-send', { type: 'button', title: 'Send (Enter)', onclick: () => this.send() }, icon('send'))))));

    this.log.addEventListener('scroll', () => { this.jump.hidden = this.nearBottom(); }, { passive: true });
    // Copy nhanh: nút Copy của khối code; bấm vào `code` trong tin (không phải lúc đang bôi chọn).
    this.log.addEventListener('click', (e) => {
      const b = e.target.closest('.code-copy');
      if (b) { copyText(b.closest('.code').querySelector('code').textContent, 'Code'); return; }
      const c = e.target.closest('.msg code');
      if (c && !c.closest('pre') && getSelection().isCollapsed) copyText(c.textContent, `“${clipText(c.textContent)}”`);
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
      else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.isComposing && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && this.recall(e.key === 'ArrowUp' ? -1 : 1)) e.preventDefault();
      e.stopPropagation();
    });
    this.input.addEventListener('input', () => this.autosize());
    if (sizeKey) this.bindResize(sizeKey);
    if (drop) this.bindDrop();
    this.input.addEventListener('paste', async (e) => {
      const dt = e.clipboardData;
      const real = [...dt.files].some((f) => window.menorah.pathOf(f));
      if (dt.types.includes('text/plain') && !real) return;
      e.preventDefault();
      // Ảnh trong clipboard không kèm tệp (ảnh chụp ⌃⇧⌘4, Copy Image) → lưu vào uploads/ rồi đính kèm.
      let paths = dt.files.length ? await droppedPaths(dt) : [];
      if (!paths.length) { const p = await window.menorah.clipboardImage(); if (p) paths = [p]; }
      if (paths.length) this.attach(paths);
    });
  }

  // Xa quá thì nhảy tới gần cuối trước, chỉ cuộn mượt đoạn cuối.
  toBottom() {
    const l = this.log, max = l.scrollHeight - l.clientHeight;
    if (max - l.scrollTop > l.clientHeight * 2) l.scrollTop = max - l.clientHeight;
    l.scrollTo({ top: l.scrollHeight, behavior: 'smooth' });
  }

  nearBottom() { return this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40; }
  // Ô soạn cao theo nội dung, tới tối đa 160px — hoặc tới chiều cao người dùng kéo (minH), khi đó thấp nhất là minH.
  autosize() {
    const t = this.input, min = this.minH || 0, max = Math.max(160, min);
    t.style.height = 'auto';
    t.style.height = `${Math.max(min, Math.min(max, t.scrollHeight))}px`;
    t.style.overflowY = t.scrollHeight > max ? 'auto' : 'hidden';
  }

  // Kéo mép trên ô soạn lên để ô cao thêm (khung Chat của IDE); nhớ theo sizeKey, nhấp đúp để về như cũ.
  bindResize(key) {
    const store = `menorah-chat-input-h:${key}`, rz = this.el.querySelector('.composer-rz');
    const clamp = (v) => Math.round(Math.max(0, Math.min(v, (this.el.clientHeight || 600) * 0.7)));
    this.minH = clamp(+localStorage.getItem(store) || 0);
    this.input.style.maxHeight = 'none';
    rz.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const y0 = e.clientY, from = this.input.offsetHeight;
      rz.classList.add('on'); document.body.classList.add('resizing-row');
      const move = (ev) => { this.minH = clamp(from + y0 - ev.clientY); this.autosize(); };
      const up = () => {
        removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
        rz.classList.remove('on'); document.body.classList.remove('resizing-row');
        localStorage.setItem(store, String(this.minH));
      };
      addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
    });
    rz.addEventListener('dblclick', () => { this.minH = 0; localStorage.removeItem(store); this.autosize(); });
    requestAnimationFrame(() => this.autosize());
  }

  // ↑ ở dòng đầu / ↓ ở dòng cuối: lật lại các prompt đã gửi (cũ nhất ← → mới nhất) như shell. Bản đang gõ dở
  // được giữ lại, ↓ quá prompt mới nhất thì trả về. Trả false khi không lật để phím mũi tên di chuyển con trỏ như thường.
  recall(dir) {
    const t = this.input, v = t.value, a = t.selectionStart, z = t.selectionEnd;
    if (dir < 0 ? v.slice(0, a).includes('\n') : v.slice(z).includes('\n')) return false;
    const list = [];
    const said = this.msgs.filter((x) => x.role === 'user'), seen = new Set(said.map((x) => (x.text || '').trim()));
    for (const m of [...said, ...this.sent.filter((x) => !seen.has(x.text.trim()))]) {
      const x = (m.text || '').trim();
      if (x && x !== list[list.length - 1]) list.push(x);
    }
    let i = this.hIdx ?? list.length;
    if (i === list.length) this.draft = v;
    else if (v !== list[i]) { i = list.length; this.draft = v; }  // đã sửa prompt cũ thì coi như bản nháp mới
    i += dir;
    if (i < 0 || i > list.length) return dir < 0 ? !!list.length : false;
    this.hIdx = i;
    t.value = i === list.length ? this.draft || '' : list[i];
    const at = dir < 0 ? 0 : t.value.length;  // lên thì con trỏ đầu (↑ tiếp lật tiếp), xuống thì cuối
    t.setSelectionRange(at, at);
    this.autosize();
    return true;
  }

  // Thả ảnh / tệp vào khung Chat (khung Chat của IDE — trên canvas, nền canvas nhận thả rồi chuyển vào đây).
  // Đường dẫn gửi kèm tin; Claude Code / Codex đọc đường dẫn ảnh trong prompt thành ảnh đính kèm.
  bindDrop() {
    const files = (e) => [...e.dataTransfer.types].some((t) => t === 'Files' || t === 'application/x-menorah-path' || t === 'text/uri-list');
    let depth = 0;
    const mark = (on) => this.composer.classList.toggle('drop', on);
    this.el.addEventListener('dragenter', (e) => { if (!files(e)) return; e.preventDefault(); depth++; mark(true); });
    this.el.addEventListener('dragover', (e) => { if (!files(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    this.el.addEventListener('dragleave', () => { if (depth && --depth === 0) mark(false); });
    this.el.addEventListener('drop', async (e) => {
      if (!files(e)) return;
      e.preventDefault(); depth = 0; mark(false);
      const paths = await droppedPaths(e.dataTransfer);
      if (paths.length) this.attach(paths); else toast('Nothing to attach — drop image files or files from Finder.');
    });
  }

  attach(paths) {
    for (const p of paths) if (!this.attachments.includes(p)) this.attachments.push(p);
    this.renderAttachments();
    this.input.focus();
  }

  renderAttachments() {
    this.thumbs ||= new Map();
    this.attEl.replaceChildren(...this.attachments.map((p) => h(`span.att${isImage(p) ? '.img' : ''}`, { title: p }, isImage(p) ? this.thumbOf(p) : null, h('span', p.split(/[\\/]/).pop()),
      h('button', { title: 'Remove', onclick: () => { this.attachments = this.attachments.filter((x) => x !== p); this.renderAttachments(); } }, icon('close')))));
  }

  // Ảnh thu nhỏ của tệp đính kèm — đọc một lần, vẽ lại thì dùng lại.
  thumbOf(p) {
    const img = h('img', { alt: '', draggable: false });
    const set = (u) => { if (u) img.src = u; else img.remove(); };
    if (this.thumbs.has(p)) set(this.thumbs.get(p));
    else window.menorah.thumb(p, 96).then((u) => { this.thumbs.set(p, u || ''); set(u); }).catch(() => img.remove());
    return img;
  }

  send() {
    const text = this.input.value.trim();
    const paths = this.attachments.map((p) => quotePath(p, this.isWin));
    if (!text && !paths.length) return;
    const body = [text, paths.join(' ')].filter(Boolean).join(text && paths.length ? '\n' : '');
    // Phiên đã dừng: gửi prompt = mở lại phiên (resume), prompt đi sau khi phiên sẵn sàng.
    if ((this.state === 'stopped' || this.state === 'exited') && this.resume) this.resume(body);
    else {
      // Dán khối (giữ xuống dòng như một tin), đợi TUI nhận xong rồi mới Enter.
      this.write(`\x1b[200~${body}\x1b[201~`);
      setTimeout(() => this.write('\r'), 80);
    }
    this.sent.push({ text: body });
    this.hIdx = null; this.draft = '';
    this.input.value = ''; this.attachments = []; this.renderAttachments(); this.autosize();
    this.pending = { text: body, at: Date.now() };
    this.render();
    setTimeout(() => this.poll(), 600);
  }

  setState(st) {
    const was = this.state;
    this.state = st;
    this.stateDot.className = `status-dot ${this.note ? 'running' : st}`;
    this.stateText.textContent = this.note || { running: 'Running', idle: 'Waiting', stopped: 'Stopped', exited: 'Exited' }[st] || '';
    const off = (st === 'stopped' || st === 'exited') && this.resume && !this.note;
    this.input.placeholder = off ? 'Session stopped — send a message to resume it' : 'Message the agent — Shift+Enter for a new line, drop files or images';
    if (this.rendered && was !== st) this.render();   // bước đang chạy thôi quay khi agent dừng
  }

  setNote(note) { this.note = note || ''; this.setState(this.state); }

  start(focus = true) { this.stop(); this.poll(); this.timer = setInterval(() => this.poll(), 1000); if (focus) setTimeout(() => this.input.focus(), 30); }
  stop() { clearInterval(this.timer); this.timer = null; this.closeMenu(); }

  // Một lượt đọc mỗi lúc: hai lượt chồng nhau cùng đọc một offset sẽ nối tin hai lần.
  async poll() {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try { await this.read(); } finally { this.busy = false; }
    if (this.again) { this.again = false; this.poll(); }
  }

  async read() {
    let r;
    try { r = await window.menorah.chatRead({ nodeId: this.node.id, agent: this.node.agent, sessionId: this.node.sessionId, offset: this.offset }); }
    catch { return; }
    if (r.sessionId !== this.sessionId) {
      // Phiên đổi (Codex vừa nhận id, /clear…): offset cũ thuộc tệp khác — đọc lại từ đầu.
      const stale = this.offset !== 0;
      this.sessionId = r.sessionId; this.msgs = []; this.offset = 0;
      if (stale) return this.read();
    }
    if (r.offset < this.offset) this.msgs = [];
    this.offset = r.offset;
    if (r.messages.length) {
      this.msgs.push(...r.messages);
      if (this.pending && r.messages.some((m) => m.role === 'user')) this.pending = null;
      this.render();
    } else if (!this.rendered) this.render();
  }

  // Mỗi lượt (mở đầu bằng tin của người dùng) là một khối; tin người dùng dính ở đầu khung khi cuộn
  // qua lượt của nó (như Cursor). Tool + thinking liền nhau thành một khối bước, result gắn vào
  // tool theo id. Tệp đã sửa của lượt cuối hiện ở khung trên ô soạn, các lượt trước hiện cuối lượt.
  render() {
    this.rendered = true;
    const atBottom = this.nearBottom();
    const msgs = this.msgs.slice(-400);
    this.results = new Map(msgs.filter((m) => m.role === 'result' && m.id).map((m) => [m.id, m]));
    const turns = [];
    let turn = null, steps = null;
    const begin = (user) => { turn = { user, items: [], files: new Map(), last: null }; turns.push(turn); };
    const flushSteps = (live) => { if (steps) turn.items.push(this.stepGroup(steps, live)); steps = null; };
    for (const m of msgs) {
      if (m.role === 'result') continue;
      if (m.role === 'user') { flushSteps(false); begin(m); continue; }
      if (!turn) begin(null);
      if (m.role === 'tool' || m.role === 'thinking') { (steps ||= []).push(m); if (m.role === 'tool') this.trackFile(m, turn.files); continue; }
      flushSteps(false);
      if (m.role === 'assistant') turn.items.push(turn.last = this.agentMsg(m));
      else turn.items.push(h('div.note-line', m.text));
    }
    if (turn) flushSteps(true);
    const lt = [...turns].reverse().find((t) => t.files.size);
    this.onFiles?.({ paths: [...new Set(turns.flatMap((t) => [...t.files.keys()]))].map((p) => this.abs(p)),
      latest: lt ? [...lt.files.keys()].map((p) => this.abs(p)) : [], last: this.lastEdit });
    if (this.pending) begin({ text: this.pending.text, ts: this.pending.at, pending: true });
    const out = turns.map((t, i) => {
      t.last?.classList.add('last');
      return h('div.turn', t.user ? this.userMsg(t.user) : null, ...t.items,
        i < turns.length - 1 && t.files.size ? this.fileList(t.files) : null);
    });
    if (!out.length) {
      out.push(h('div.chat-empty', this.node.agent === 'codex' && !this.node.sessionId
        ? 'No transcript for this Codex session yet. Send the first message and the conversation shows up here.'
        : 'No messages yet. Type a request below, or switch to CLI to work in the terminal.'));
    }
    this.log.replaceChildren(...out);
    this.renderFiles(turns.at(-1)?.files);
    this.renderMeta(msgs);
    if (atBottom || this.pending) this.log.scrollTop = this.log.scrollHeight;
    this.jump.hidden = this.nearBottom();
  }

  btn(name, title, fn, cls = '') { return h(`button.chat-act${cls}`, { type: 'button', title, onclick: (e) => { e.stopPropagation(); fn(); } }, icon(name)); }

  // Copy + giờ dưới tin của agent: tin cuối lượt luôn hiện, các tin khác hiện khi rê chuột.
  actions(m) {
    return h('div.msg-actions', this.btn('copy', 'Copy message', () => copyText(m.text, 'Message')),
      m.ts ? h('span.msg-time', { title: new Date(m.ts).toLocaleString() }, timeAgo(m.ts)) : null);
  }

  // Tin người dùng: gọn 3 dòng (bấm để mở hết), Reuse + Copy ở góc khi rê chuột.
  userMsg(m) {
    const key = `${m.ts}${m.text.length}`, full = this.fullUser.has(key);
    const box = h(`div.msg.user${full ? '.full' : ''}${m.pending ? '.pending' : ''}`, {
      title: full ? '' : 'Click to show the whole message',
      onclick: () => {
        if (getSelection().type === 'Range') return;
        full ? this.fullUser.delete(key) : this.fullUser.add(key);
        box.replaceWith(this.userMsg(m));
      } },
      h('div.user-text', m.text, m.images ? h('span.img-tag', `[${m.images} image${m.images > 1 ? 's' : ''}]`) : null),
      m.pending ? null : h('div.user-acts',
        m.ts ? h('span.msg-time', { title: new Date(m.ts).toLocaleString() }, timeAgo(m.ts)) : null,
        this.btn('restart', 'Reuse — put this message back in the box to edit and send again', () => { this.input.value = m.text; this.autosize(); this.input.focus(); }),
        this.btn('copy', 'Copy message', () => copyText(m.text, 'Message'))));
    return h('div.turn-user', box);
  }

  agentMsg(m) { return h('div.turn-agent', h('div.msg.assistant', { html: md(m.text) }), this.actions(m)); }

  // Nhiều bước thì chỉ hiện 4 bước cuối, bấm để xem cả khối.
  stepGroup(list, live) {
    const key = list[0].id || `g${list[0].ts}`;
    const hidden = list.length > 6 && !this.openGroups.has(key) ? list.length - 4 : 0;
    const box = h('div.steps');
    if (hidden) box.append(h('button.steps-more', { type: 'button', onclick: () => { this.openGroups.add(key); box.replaceWith(this.stepGroup(list, live)); } }, `Show ${hidden} earlier steps`));
    box.append(...list.slice(hidden).map((m) => this.step(m, live)));
    return box;
  }

  step(m, live) {
    const key = m.id || `${m.role}${m.ts}${m.name || ''}${m.text.length}`;
    const open = this.open.has(key);
    const r = m.id ? this.results.get(m.id) : null;
    const t = m.role === 'thinking' ? { label: 'Thought', brief: m.text.split('\n').find((l) => l.trim()) || '' } : toolInfo(m, r, this.node.cwd);
    const status = m.role === 'thinking' ? null
      : r?.error ? h('span.step-st.err', 'Error')
      : r ? t.stat || h('span.step-st.ok', icon('check'))
      : live && this.state === 'running' ? h('span.step-st', h('span.spin')) : null;
    const el = h(`div.step${open ? '.open' : ''}${r?.error ? '.error' : ''}${m.role === 'thinking' ? '.thinking' : ''}`,
      h('div.step-head', { title: open ? 'Hide details' : 'Show details', onclick: () => {
        if (getSelection().type === 'Range') return;
        open ? this.open.delete(key) : this.open.add(key);
        el.replaceWith(this.step(m, live));
      } },
      icon('chev', 'step-chev'), h('b', t.label), h(`span.step-brief${t.plain || m.role === 'thinking' ? '.plain' : ''}`, { title: t.brief }, t.brief), status,
      t.copy ? this.btn('copy', `Copy ${t.what.toLowerCase()}`, () => copyText(t.copy, t.what)) : null),
      open ? h('div.step-body', m.role === 'thinking' ? h('div.step-think', m.text) : t.body()) : null);
    return el;
  }

  // Tệp mà lượt này đã sửa / tạo, kèm số dòng thêm / bớt. Write không có patch = tệp mới.
  trackFile(m, files) {
    const r = this.results.get(m.id);
    if (r?.error) return;
    const i = m.input && typeof m.input === 'object' ? m.input : {};
    if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(m.name) && (i.file_path || i.notebook_path)) {
      const p = i.file_path || i.notebook_path, f = files.get(p) || { add: 0, del: 0, st: m.name === 'Write' && r && !r.patch?.length ? 'A' : 'M' };
      for (const l of diffLines(m, r)) { if (l[0] === '+') f.add++; else if (l[0] === '-') f.del++; }
      files.set(p, f);
      if (r) this.lastEdit = { id: m.id, path: this.abs(p) };
    } else if (m.name === 'apply_patch') {
      // Codex: input là chuỗi patch, chỉ còn đoạn đầu trong m.text.
      for (const x of (m.text || '').matchAll(/\*\*\* (Update|Add|Delete) File: (\S+)/g)) {
        if (!files.has(x[2])) files.set(x[2], { add: 0, del: 0, st: x[1][0] === 'U' ? 'M' : x[1][0] });
        if (r) this.lastEdit = { id: m.id, path: this.abs(x[2]) };
      }
    }
  }

  // Danh sách tệp: bấm dòng mở diff ở tab Project; nút copy chép đường dẫn.
  fileList(files, toggle) {
    const paths = [...files.keys()], open = !toggle || this.filesOpen;
    const all = () => copyText(paths.join('\n'), paths.length > 1 ? 'Paths' : 'Path');
    return h('div.chat-filelist',
      h('div.cf-sec', toggle ? { onclick: () => { this.filesOpen = !this.filesOpen; this.renderFiles(files); }, title: open ? 'Hide the files' : 'Show the files' } : null,
        toggle ? h(`span.cf-chev${open ? '.open' : ''}`, '›') : null,
        h('span', paths.length > 1 ? 'Files changed' : 'File changed'), h('span.cf-count', String(paths.length)), h('span.grow'),
        this.btn('copy', 'Copy all paths', all, '.cf-icon'),
        this.btn('external', 'Review — open every change in the IDE\'s Review tab', () => this.review(null), '.cf-icon')),
      open ? h('div.cf-list', paths.map((p) => {
        const f = files.get(p), r = relPath(p, this.node.cwd), dir = r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : '';
        return h(`div.cf-row.chat-file.st-${f.st}`, { title: `${p}\nClick to open the diff in Project`, onclick: () => this.review(p) },
          h('span.cf-name', baseName(r)), h('span.cf-path', dir),
          f.add ? h('span.add', `+${f.add}`) : null, f.del ? h('span.del', `−${f.del}`) : null,
          this.btn('copy', 'Copy path', () => copyText(p, 'Path'), '.cf-icon'),
          h(`span.cf-st.st-${f.st}`, f.st));
      })) : null);
  }

  renderFiles(files) {
    this.filesEl.hidden = !files?.size;
    this.filesEl.replaceChildren(files?.size ? this.fileList(files, true) : '');
  }

  // Đường dẫn tệp trong transcript: Claude ghi tuyệt đối, apply_patch của Codex tương đối với cwd.
  abs(p) { return /^(\/|[A-Za-z]:[\\/])/.test(p) ? p : `${(this.node.cwd || '').replace(/[\\/]+$/, '')}/${p}`; }

  // Mở diff WIP của tệp ở tab Project (git.html tìm worktree chứa tệp); p = null: tab Review của worktree agent.
  review(p) {
    if (typeof app === 'undefined') return p ? copyText(this.abs(p), 'Path') : null;
    app.reviewFile(p ? this.abs(p) : null, { nodeId: this.node.id, cwd: this.node.cwd });
  }

  // Thanh dưới: model (bấm để đổi), cỡ context của request gần nhất, session ID — bấm là copy.
  renderMeta(msgs) {
    let model = '', tokens = 0, at = -1;
    for (let i = msgs.length - 1; i >= 0 && !(model && tokens); i--) {
      if (!model && msgs[i].model && msgs[i].model[0] !== '<') { model = msgs[i].model; at = i; }
      tokens ||= msgs[i].tokens || 0;
    }
    // Vừa chọn model: hiện model đã chọn tới khi transcript có câu trả lời mới (của model đó).
    if (this.picked && at >= this.picked.n) this.picked = null;
    this.model = model;
    const sid = this.sessionId, shown = this.picked?.id || model;
    this.metaEl.replaceChildren(
      CHAT_MODELS[this.node.agent]
        ? h('button.meta.chat-model', { type: 'button', title: `${shown || 'Model'} — click to switch model`, onclick: (e) => this.modelMenu(e.currentTarget) },
          shown ? shown.replace(/^claude-/, '') : 'model', icon('chev'))
        : model ? h('button.meta', { type: 'button', title: `${model} — click to copy`, onclick: () => copyText(model, 'Model ID') }, model.replace(/^claude-/, '')) : '',
      tokens ? h('span.meta', { title: 'Context size of the last request' }, `${fmtTokens(tokens)} ctx`) : '',
      sid ? h('button.meta', { type: 'button', title: `Session ${sid} — click to copy`, onclick: () => copyText(sid, 'Session ID') }, icon('copy'), sid.slice(0, 8)) : '');
  }

  // Đổi model của phiên: gõ `/model <id>` vào CLI như người gõ (Claude Code). Codex chỉ có danh sách
  // /model tương tác — mở nó ra, chọn bằng 1 / 2 / 3 / Enter ở thanh dưới.
  modelMenu(btn) {
    if (this.menu) return this.closeMenu();
    const cur = this.picked?.id || this.model, list = CHAT_MODELS[this.node.agent];
    const pick = (id) => {
      this.closeMenu();
      this.write(`\x1b[200~/model${id ? ` ${id}` : ''}\x1b[201~`);
      setTimeout(() => this.write('\r'), 80);
      if (!id) return toast('Codex opened its model list — pick one with 1 / 2 / 3 and Enter below.');
      this.picked = { id: id === 'default' ? '' : id, n: this.msgs.length };
      if (!this.picked.id) this.picked = null;
      this.renderMeta(this.msgs);
      toast(`Switching to ${id === 'default' ? 'the default model' : id} — it applies to your next message`);
    };
    const item = (label, sub, act, on) => h(`button.menu-item${on ? '.on' : ''}`, { type: 'button', onclick: act },
      h('span.grow', h('span', label), sub ? h('span.sub', sub) : null), on ? icon('check') : null);
    const other = h('input.menu-filter', { type: 'text', placeholder: 'Other model ID — Enter to switch', spellcheck: false,
      onkeydown: (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') this.closeMenu();
        if (e.key === 'Enter' && !e.isComposing && /^[\w.:@/[\]-]{1,120}$/.test(e.target.value.trim())) pick(e.target.value.trim());
      } });
    const m = h('div.menu.chat-model-menu', { onmousedown: (e) => e.stopPropagation() },
      h('div.menu-hd', 'Model'),
      ...(list.length ? [...list.map(([id, label]) => item(label, id === 'default' ? 'Account default' : id, () => pick(id), id !== 'default' && !!cur && cur.startsWith(id))),
        other]
        : [item('Choose in Codex…', '/model — then pick with 1 / 2 / 3', () => pick(''))]),
      this.model && h('div.menu-sep'),
      this.model && item('Copy model ID', this.model, () => { this.closeMenu(); copyText(this.model, 'Model ID'); }));
    document.body.append(m);
    const r = btn.getBoundingClientRect();
    m.style.position = 'fixed';
    m.style.top = `${Math.max(8, r.top - m.offsetHeight - 6)}px`;
    m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`;
    this.menu = m;
    this.menuOff = (e) => { if (e.type === 'keydown' ? e.key === 'Escape' : !m.contains(e.target)) this.closeMenu(); };
    addEventListener('mousedown', this.menuOff, true); addEventListener('keydown', this.menuOff, true); addEventListener('blur', this.menuOff);
  }

  closeMenu() {
    this.menu?.remove(); this.menu = null;
    removeEventListener('mousedown', this.menuOff, true); removeEventListener('keydown', this.menuOff, true); removeEventListener('blur', this.menuOff);
  }
}

// Model chọn được ở thanh dưới khung Chat. Codex: rỗng — dùng danh sách /model của chính Codex.
const CHAT_MODELS = {
  claude: [['default', 'Default'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5'], ['claude-fable-5-1', 'Fable 5.1']],
  codex: [],
};

const baseName = (p) => String(p || '').split(/[\\/]/).pop();
const relPath = (p, cwd) => (cwd && p && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p || '');
const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const clipText = (s, n = 48) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Khối chữ trong phần chi tiết của bước, có nút Copy ở góc.
function textBlock(text, what, cls = '') {
  return h(`div.step-block${cls}`, h('button.chat-act.block-copy', { type: 'button', title: `Copy ${what.toLowerCase()}`, onclick: (e) => { e.stopPropagation(); copyText(text, what); } }, icon('copy')),
    h('pre', text));
}

// Các dòng diff (" ", "+", "-") của Edit / Write: lấy patch agentd gửi; thiếu thì dựng từ input.
function diffLines(m, r) {
  if (r?.patch?.length) return r.patch.flatMap((x) => x.lines);
  const i = m.input || {}, lines = (s) => String(s ?? '').split('\n');
  if (m.name === 'Edit') return [...lines(i.old_string).map((l) => `-${l}`), ...lines(i.new_string).map((l) => `+${l}`)];
  if (m.name === 'MultiEdit') return (i.edits || []).flatMap((e) => [...lines(e.old_string).map((l) => `-${l}`), ...lines(e.new_string).map((l) => `+${l}`)]);
  if (m.name === 'Write' && typeof i.content === 'string') return lines(i.content).slice(0, 400).map((l) => `+${l}`);
  return [];
}

function diffView(m, r) {
  const hunks = r?.patch?.length ? r.patch : [{ oldStart: 0, newStart: 0, lines: diffLines(m, r) }];
  const rows = [], text = [];
  for (const x of hunks) {
    let o = x.oldStart, n = x.newStart;
    if (o || n) { rows.push(h('div.dl.hunk', h('span.ln'), h('span', `@@ -${o} +${n} @@`))); text.push(`@@ -${o} +${n} @@`); }
    for (const l of x.lines) {
      const k = l[0], cls = k === '+' ? '.add' : k === '-' ? '.del' : '';
      const num = !(o || n) ? '' : k === '+' ? n++ : k === '-' ? o++ : (o++, n++);
      rows.push(h(`div.dl${cls}`, h('span.ln', String(num)), h('span', l.slice(1) || ' ')));
      text.push(l);
    }
  }
  if (!rows.length) return null;
  return h('div.step-block.diff', h('button.chat-act.block-copy', { type: 'button', title: 'Copy diff', onclick: (e) => { e.stopPropagation(); copyText(text.join('\n'), 'Diff'); } }, icon('copy')),
    h('div.diff-rows', rows));
}

// Mỗi loại tool: nhãn, dòng tóm tắt, thứ đáng copy nhất (lệnh, đường dẫn, URL…), và phần chi tiết.
function toolInfo(m, r, cwd) {
  const i = m.input && typeof m.input === 'object' && !Array.isArray(m.input) ? m.input : {};
  const name = m.name || 'Tool', out = r?.text || '';
  const result = (what = 'Output') => (out ? textBlock(out, what, r.error ? '.err' : '') : null);
  const kv = (rows) => h('div.step-kv', rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => [h('span', k), h('code', String(v))]));
  const path = i.file_path || i.notebook_path;
  let cmd = typeof i.command === 'string' ? i.command : Array.isArray(i.command) ? i.command : i.cmd;
  if (Array.isArray(cmd)) cmd = /^(ba|z)?sh$/.test(baseName(cmd[0])) && /^-l?c$/.test(cmd[1]) ? cmd.slice(2).join(' ') : cmd.join(' ');
  if (typeof cmd === 'string' && cmd && !path) {
    return { label: name, brief: i.description || cmd, plain: !!i.description, copy: cmd, what: 'Command',
      body: () => [textBlock(cmd, 'Command', '.cmd'), result()] };
  }
  if (path && /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) {
    const ls = diffLines(m, r), add = ls.filter((l) => l[0] === '+').length, del = ls.filter((l) => l[0] === '-').length;
    return { label: name, brief: relPath(path, cwd), copy: path, what: 'Path',
      stat: r && !r.error && (add || del) ? h('span.step-st.diffstat', add ? h('span.add', `+${add}`) : '', del ? h('span.del', `−${del}`) : '') : null,
      body: () => [r?.error ? result('Error') : diffView(m, r) || result()] };
  }
  if (path && name === 'Read') {
    const range = i.offset || i.limit ? `:${i.offset || 1}${i.limit ? `–${(i.offset || 1) + i.limit - 1}` : ''}` : '';
    return { label: 'Read', brief: relPath(path, cwd) + range, copy: path, what: 'Path',
      stat: r && !r.error && out ? h('span.step-st', out.replace(/ \(from line 1 of (\d+)\)$/, ' of $1')) : null,
      body: () => [kv([['File', path], ['From line', i.offset], ['Lines', i.limit]]), r?.error ? result('Error') : out ? h('div.step-note', out) : null] };
  }
  if (/^(Grep|Glob)$/.test(name) && i.pattern) {
    return { label: name, brief: i.pattern + (i.path ? `  in ${relPath(i.path, cwd)}` : ''), copy: i.pattern, what: 'Pattern',
      body: () => [kv([['Pattern', i.pattern], ['In', i.path], ['Files', i.glob || i.type], ['Mode', i.output_mode]]), result('Results')] };
  }
  if (i.url) {
    return { label: name, brief: i.url, copy: i.url, what: 'URL', body: () => [kv([['URL', i.url]]), i.prompt ? h('div.step-note', i.prompt) : null, result('Result')] };
  }
  if (i.query && typeof i.query === 'string') {
    return { label: name, brief: i.query, copy: i.query, what: 'Query', body: () => [result('Results')] };
  }
  if (/^(Task|Agent)$/.test(name) && i.prompt) {
    return { label: i.subagent_type ? `Agent · ${i.subagent_type}` : 'Agent', brief: i.description || clipText(i.prompt, 120), plain: true, copy: i.prompt, what: 'Prompt',
      body: () => [textBlock(i.prompt, 'Prompt'), out && !r.error ? h('div.step-md.msg', { html: md(out) }) : result('Error')] };
  }
  if (name === 'TodoWrite' && Array.isArray(i.todos)) {
    const done = i.todos.filter((x) => x.status === 'completed').length, now = i.todos.find((x) => x.status === 'in_progress');
    const list = i.todos.map((x) => `${x.status === 'completed' ? '[x]' : '[ ]'} ${x.content}`).join('\n');
    return { label: 'To-dos', brief: `${done} of ${i.todos.length} done${now ? ` · ${now.activeForm || now.content}` : ''}`,
      plain: true, copy: list, what: 'To-do list',
      body: () => [h('ul.todos', i.todos.map((x) => h(`li.${x.status || 'pending'}`, h('span.box', x.status === 'completed' ? icon('check') : ''), h('span', x.content))))] };
  }
  const input = Object.keys(i).length ? JSON.stringify(i, null, 2) : '';
  return { label: name, brief: m.text || '', copy: m.text || '', what: 'Input',
    body: () => [input ? textBlock(input, 'Input') : m.text ? textBlock(m.text, 'Input') : null, result()] };
}
