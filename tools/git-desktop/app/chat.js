// Khung Chat của một node agent. Không phải phiên riêng: đọc transcript của CHÍNH phiên đang
// chạy trong terminal (poll 1 giây khi đang mở), tin gõ ở ô soạn được dán thẳng vào terminal
// bằng bracketed paste rồi Enter — như người gõ. Chuyển CLI ↔ Chat không mất gì.
'use strict';

class ChatView {
  constructor(node, { write, onFocus, isWin }) {
    this.node = node;               // doc node (agent, sessionId)
    this.write = write;             // (data) => gửi vào PTY
    this.isWin = isWin;
    this.offset = 0;
    this.sessionId = null;
    this.msgs = [];
    this.attachments = [];
    this.timer = null;

    this.log = h('div.chat-log');
    this.attEl = h('div.attachments');
    this.input = h('textarea', { rows: 1, placeholder: 'Message the agent… (Enter to send, Shift+Enter for a new line, drop files or images here)' });
    this.stateDot = h('span.status-dot');
    this.stateText = h('span');
    const key = (label, data, title) => h('button', { title, onclick: () => { this.write(data); this.input.focus(); } }, label);
    this.el = h('div.chat', { onmousedown: onFocus },
      this.log,
      h('div.chat-foot',
        h('div.chat-keys', 'Keys:', key('Esc', '\x1b', 'Interrupt / close the picker'), key('Enter', '\r', 'Confirm the highlighted choice'),
          key('1', '1', 'Pick option 1 (usually Yes)'), key('2', '2', 'Pick option 2'), key('3', '3', 'Pick option 3'),
          h('span.state', this.stateDot, this.stateText)),
        this.attEl,
        h('div.composer', this.input, h('button.primary', { title: 'Send (Enter)', onclick: () => this.send() }, icon('send'), 'Send'))));

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
      e.stopPropagation();
    });
    this.input.addEventListener('input', () => this.autosize());
    this.input.addEventListener('paste', async (e) => {
      const hasText = e.clipboardData.types.includes('text/plain');
      const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
      if (!file || hasText) return;
      e.preventDefault();
      const p = window.menorah.pathOf(file) || await window.menorah.saveFile(new Uint8Array(await file.arrayBuffer()), file.name || 'clipboard.png');
      this.attach([p]);
    });
  }

  autosize() { this.input.style.height = 'auto'; this.input.style.height = `${Math.min(160, this.input.scrollHeight)}px`; }

  attach(paths) {
    for (const p of paths) if (!this.attachments.includes(p)) this.attachments.push(p);
    this.renderAttachments();
    this.input.focus();
  }

  renderAttachments() {
    this.attEl.replaceChildren(...this.attachments.map((p) => h('span.att', { title: p }, h('span', p.split(/[\\/]/).pop()),
      h('button', { title: 'Remove', onclick: () => { this.attachments = this.attachments.filter((x) => x !== p); this.renderAttachments(); } }, icon('close')))));
  }

  send() {
    const text = this.input.value.trim();
    const paths = this.attachments.map((p) => quotePath(p, this.isWin));
    if (!text && !paths.length) return;
    const body = [text, paths.join(' ')].filter(Boolean).join(text && paths.length ? '\n' : '');
    // Dán khối (giữ xuống dòng như một tin), đợi TUI nhận xong rồi mới Enter.
    this.write(`\x1b[200~${body}\x1b[201~`);
    setTimeout(() => this.write('\r'), 80);
    this.input.value = ''; this.attachments = []; this.renderAttachments(); this.autosize();
    this.pending = { text: body, at: Date.now() };
    this.render();
    setTimeout(() => this.poll(), 600);
  }

  setState(st) {
    this.stateDot.className = `status-dot ${st}`;
    this.stateText.textContent = { running: 'Running', idle: 'Waiting', stopped: 'Stopped', exited: 'Exited' }[st] || '';
  }

  start() { this.stop(); this.poll(); this.timer = setInterval(() => this.poll(), 1000); setTimeout(() => this.input.focus(), 30); }
  stop() { clearInterval(this.timer); this.timer = null; }

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

  render() {
    this.rendered = true;
    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
    const out = [];
    let tools = null;
    const flushTools = () => {
      if (!tools) return;
      const list = tools;
      const box = h('div.tools');
      const shown = list.length > 4 ? list.slice(-3) : list;
      if (list.length > 4) box.append(h('button.tools-more', { onclick: () => { box.replaceChildren(...list.map(tool)); } }, `+${list.length - 3} steps`));
      box.append(...shown.map(tool));
      out.push(box); tools = null;
    };
    const tool = (m) => h(`span.tool${m.error ? '.error' : ''}`, { title: m.text }, h('b', m.name), h('span', m.text));
    const msgs = this.msgs.slice(-400);
    for (const m of msgs) {
      if (m.role === 'tool') { (tools ||= []).push(m); continue; }
      flushTools();
      if (m.role === 'user') out.push(h('div.msg.user', m.text, m.images ? h('span.img-tag', `[${m.images} image${m.images > 1 ? 's' : ''}]`) : null));
      else if (m.role === 'assistant') out.push(h('div.msg.assistant', { html: md(m.text) }));
      else out.push(h('div.note-line', m.text));
    }
    flushTools();
    if (this.pending) out.push(h('div.msg.user', { style: 'opacity:.6' }, this.pending.text));
    if (!out.length) {
      out.push(h('div.chat-empty', this.node.agent === 'codex' && !this.node.sessionId
        ? 'No transcript for this Codex session yet. Send the first message and the conversation shows up here.'
        : 'No messages yet. Type a request below, or switch to CLI to work in the terminal.'));
    }
    this.log.replaceChildren(...out);
    if (atBottom || this.pending) this.log.scrollTop = this.log.scrollHeight;
  }
}
