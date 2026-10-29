// Khung Chat của agent ở chế độ IDE của tab Project (Graph | Files | IDE): cột phải cạnh trang Git,
// chỉ hiện khi git.html báo đang ở IDE. Bấm agent Claude / Codex ở tab Agents (git.html) là mở nó ở đây. Cùng ChatView với node trên canvas — đọc transcript của phiên
// đang chạy, tin gõ ghi thẳng vào PTY của node. Tệp agent đã sửa được báo cho git.html để đánh
// dấu ở WIP; bật Follow thì mỗi lần agent sửa xong một tệp, diff của tệp đó tự mở ở trang Git.
// Mỗi agent đã mở là một tab trên đầu khung: bấm để chuyển, × để bỏ khỏi khung (agent vẫn chạy trên canvas).
// Chỉ hiện tab của agent làm việc trong repo đang xem ở trang Git; đổi repo thì sang agent dùng gần nhất
// của repo đó (tab của repo khác vẫn nhớ, quay lại là thấy).
// Dòng dưới tab: hạn mức gói Claude (5 giờ / 7 ngày) và token / chi phí của phiên — số do proxy AI Hub ghi.
'use strict';

const DOCK_KEY = 'menorah.dock';   // { nodeId, tabs, w, follow, last }
const QUOTA_MS = 15000;

const AgentDock = {
  a: null,          // agent đang mở (một dòng của window.menorah.agents())
  chat: null,
  last: null,       // id tool của lần sửa tệp gần nhất đã thấy — Follow chỉ chạy khi nó đổi
  paths: [],
  agents: [],       // danh sách agent gần nhất — khung trống liệt kê để chọn
  ide: false,       // git.html đang ở chế độ IDE
  live: false,      // ChatView đang đọc transcript
  tabs: [],         // nodeId các agent đang mở thành tab, theo thứ tự
  drafts: new Map(),// nodeId → chữ đang gõ dở khi chuyển tab
  roots: [],        // worktree của repo đang xem ở trang Git (rỗng: chưa biết — hiện mọi agent)
  lastBy: {},       // worktree chính của repo → nodeId agent mở gần nhất ở repo đó

  init(app) {
    this.app = app;
    let st = {};
    try { st = JSON.parse(localStorage.getItem(DOCK_KEY)) || {}; } catch {}
    this.want = typeof st.nodeId === 'string' ? st.nodeId : null;   // mở lại khi danh sách agent về
    this.follow = st.follow !== false;
    this.tabs = Array.isArray(st.tabs) ? st.tabs.filter((x) => typeof x === 'string').slice(0, 20) : [];
    if (st.last && typeof st.last === 'object') for (const [k, v] of Object.entries(st.last)) if (typeof v === 'string') this.lastBy[k] = v;
    this.el = $('#git-dock');
    this.rz = $('#git-dock-rz');
    this.setWidth(st.w || 440);
    this.rz.addEventListener('pointerdown', (e) => this.drag(e));
    this.rz.addEventListener('dblclick', () => { this.setWidth(440); this.save(); });
  },

  save() { localStorage.setItem(DOCK_KEY, JSON.stringify({ nodeId: this.a?.nodeId || null, tabs: this.tabs, w: this.w, follow: this.follow, last: this.lastBy })); },

  // Agent thuộc repo đang xem: thư mục làm việc nằm trong một worktree của nó (như cột Agents của git.html).
  mine(x) {
    const cwd = String(x?.cwd || '').replace(/\/+$/, '');
    return !this.roots.length || this.roots.some((r) => cwd === r || cwd.startsWith(r + '/'));
  },
  // Tab hiện trên khung: của repo đang xem, cộng agent đang mở (có thể mở từ repo khác qua nút +).
  // Agent chưa có trong danh sách (vừa tạo) cứ hiện.
  shown() {
    const by = new Map(this.agents.map((x) => [x.nodeId, x]));
    return this.tabs.filter((id) => id === this.a?.nodeId || !by.has(id) || this.mine(by.get(id)));
  },

  setWidth(w) {
    this.w = Math.round(Math.max(320, Math.min(w, window.innerWidth - 480, 900)));
    this.el.style.width = `${this.w}px`;
  },

  // Rê mép trái để đổi bề rộng. iframe nuốt pointermove nên tắt pointer-events của nó lúc rê.
  drag(e) {
    e.preventDefault();
    const x0 = e.clientX, w0 = this.w;
    document.body.classList.add('dock-resizing');
    const move = (ev) => this.setWidth(w0 + x0 - ev.clientX);
    const up = () => {
      document.body.classList.remove('dock-resizing');
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      this.save();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  },

  async open(nodeId, { focus = true } = {}) {
    if (this.a?.nodeId === nodeId) return focus && this.chat?.input.focus();
    let a;
    try { a = (await window.menorah.agents()).find((x) => x.nodeId === nodeId); } catch {}
    if (!a) { this.dropTab(nodeId); return toast('This agent is no longer on any canvas.'); }
    if (a.agent === 'shell') return this.app.goNode(a.projectId, a.nodeId, a.canvasId);
    this.close(true);
    if (!this.tabs.includes(nodeId)) this.tabs.push(nodeId);
    if (this.roots.length && this.mine(a)) this.remember(nodeId);
    this.a = a; this.last = undefined; this.paths = []; this.latest = []; this.sig = null;
    this.chat = new ChatView({ id: a.nodeId, agent: a.agent, sessionId: a.sessionId, cwd: a.cwd }, {
      write: (d) => {
        if (this.a.status === 'stopped') return toast('The session is stopped — send a message or click Resume.');
        window.menorah.ptyWrite(a.nodeId, d);
      },
      resume: (p) => this.resume(p),
      onFocus: () => {},
      isWin: this.app.info.platform === 'win32',
      onFiles: (f) => this.files(f),
      sizeKey: 'dock',
      drop: true,
    });
    const draft = this.drafts.get(nodeId);
    if (draft) { this.chat.input.value = draft; this.chat.input.dispatchEvent(new Event('input')); }
    this.render();
    this.live = false;
    this.sync(focus);
    this.chat.setState(a.status);
    this.save();
    this.post();
  },

  remember(nodeId) {
    delete this.lastBy[this.roots[0]];
    this.lastBy[this.roots[0]] = nodeId;
    const ks = Object.keys(this.lastBy);
    for (const k of ks.slice(0, Math.max(0, ks.length - 50))) delete this.lastBy[k];
  },

  // keep: đang mở agent khác ngay sau đó — khỏi báo git.html hai lần, khỏi xoá chỗ đã nhớ.
  close(keep) {
    if (this.chat) this.drafts.set(this.a.nodeId, this.chat.input.value);
    this.chat?.stop();
    this.closeMenu();
    clearTimeout(this.quotaT); this.quotaT = null;
    this.chat = null; this.a = null; this.paths = []; this.latest = []; this.sig = null; this.live = false;
    this.el.replaceChildren();
    if (keep) return;
    this.want = null;
    this.tabs = [];
    this.save();
    this.post();
    this.renderEmpty();
  },

  // Chưa chọn agent: liệt kê agent Claude / Codex trên các canvas để chọn.
  // Agent của repo đang xem trước; repo chưa có agent nào thì liệt kê agent ở repo khác bên dưới.
  renderEmpty() {
    const all = this.agents.filter((a) => a.agent !== 'shell'), list = all.filter((a) => this.mine(a)), rest = all.filter((a) => !this.mine(a));
    this.emptySig = this.emptySigOf();
    const pick = (a) => h('button.dock-pick', { type: 'button', title: a.cwd, onclick: () => this.open(a.nodeId) },
      h(`span.dock-mk.${a.agent}`, a.agent === 'codex' ? 'X' : 'C'),
      h('div.dock-tx', h('b', a.title), h('span', `${a.projectName} › ${a.canvasName}`)),
      h(`span.status-dot.${a.status}`));
    this.el.replaceChildren(
      h('div.dock-head', h('div.dock-tx', h('b', 'Agent chat'), h('span', list.length ? 'Pick an agent of this repository' : 'Pick an agent to chat with it here'))),
      h('div.dock-empty', ...(list.length ? list.map(pick)
        : [h('p', all.length ? 'No Claude or Codex agent works in this repository yet. Add one with + next to a worktree in Agents on the left.'
          : 'No Claude or Codex agent on any canvas yet. Add one with + next to a worktree in Agents on the left.'),
          ...(rest.length ? [h('div.dock-empty-hd', 'Other repositories'), ...rest.map(pick)] : [])])));
  },
  emptySigOf() {
    return [this.roots.join('|'), ...this.agents.filter((a) => a.agent !== 'shell').map((a) => [a.nodeId, a.status, a.title].join('|'))].join('\n');
  },

  // Mở lại phiên đã dừng (rồi gửi prompt nếu có) — cache nguội thì /compact trước, xem Canvas.resumeSend.
  async resume(prompt) {
    const a = this.a, chat = this.chat;
    this.stopped.hidden = true;
    await this.app.canvas.resumeSend({ id: a.nodeId, agent: a.agent, cwd: a.cwd, sessionId: a.sessionId }, prompt, chat);
    this.app.pushAgents();
  },

  render() {
    const a = this.a, b = (name, title, fn, cls = '') => h(`button.dock-btn${cls}`, { type: 'button', title, onclick: fn }, icon(name));
    this.followBtn = b('eye', '', () => { this.follow = !this.follow; this.paintFollow(); this.save(); }, '.follow');
    this.paintFollow();
    this.stopped = h('div.dock-stopped', { hidden: a.status !== 'stopped' }, h('span', 'This session is stopped — send a message to resume it.'),
      h('button', { type: 'button', onclick: () => this.resume(null) }, 'Resume'));
    this.tabsEl = h('div.dock-tabs', { onwheel: (e) => { if (!e.deltaX) { this.tabsEl.scrollLeft += e.deltaY; e.preventDefault(); } } });
    this.addBtn = b('plus', 'Open another agent in a tab', () => this.agentMenu(this.addBtn));
    this.where = h('span.dock-where');
    this.quota = h('div.dock-quota');
    this.el.replaceChildren(
      h('div.dock-head', this.tabsEl, this.addBtn, this.followBtn,
        b('external', 'Open on the canvas', () => this.app.goNode(this.a.projectId, this.a.nodeId, this.a.canvasId))),
      h('div.dock-info', this.where, this.quota),
      this.stopped,
      h('div.dock-body', this.chat.el));
    this.renderTabs();
    this.paintQuota(this.usage);
  },

  // Một tab mỗi agent đã mở. Tên / trạng thái lấy từ danh sách agent định kỳ (agent chưa có trong đó: tên tạm).
  renderTabs() {
    if (!this.tabsEl || !this.a) return;
    const by = new Map(this.agents.map((x) => [x.nodeId, x]));
    by.set(this.a.nodeId, this.a);
    this.tabSig = this.tabSigOf();
    this.tabsEl.replaceChildren(...this.shown().map((id) => {
      const x = by.get(id) || { nodeId: id, agent: 'claude', title: 'Agent', status: 'stopped' };
      const on = id === this.a.nodeId;
      return h(`div.dock-tab${on ? '.on' : ''}`, {
        title: `${x.title}${x.projectName ? `\n${x.projectName} › ${x.canvasName}` : ''}${x.cwd ? `\n${x.cwd}` : ''}`,
        onclick: () => this.open(id), onauxclick: (e) => { if (e.button === 1) this.closeTab(id); },
        onmousedown: (e) => { if (e.button === 1) e.preventDefault(); },
      },
        h(`span.dock-mk.${x.agent}`, x.agent === 'codex' ? 'X' : 'C'),
        h('span.dock-tab-t', x.title),
        h(`span.status-dot.${x.status}`, { title: { running: 'Running', idle: 'Waiting for input', stopped: 'Stopped' }[x.status] || x.status }),
        h('button.dock-tab-x', { type: 'button', title: 'Close the tab (the agent keeps running on its canvas)',
          onclick: (e) => { e.stopPropagation(); this.closeTab(id); } }, icon('close')));
    }));
    this.where.textContent = `${this.a.projectName} › ${this.a.canvasName}`;
    this.where.title = this.a.cwd;
    this.tabsEl.querySelector('.dock-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  },

  tabSigOf() {
    const by = new Map(this.agents.map((x) => [x.nodeId, x]));
    return [this.a?.nodeId, this.roots.join('|'), ...this.shown().map((id) => { const x = by.get(id); return x ? [id, x.title, x.status, x.projectName, x.canvasName].join('|') : id; })].join('\n');
  },

  closeTab(id) {
    const vis = this.shown(), i = vis.indexOf(id);
    if (!this.tabs.includes(id)) return;
    this.tabs.splice(this.tabs.indexOf(id), 1);
    this.drafts.delete(id);
    if (this.a?.nodeId !== id) { this.save(); return this.renderTabs(); }
    vis.splice(i, 1);
    const next = vis[Math.min(i, vis.length - 1)];
    if (next) return this.open(next);
    if (this.tabs.length) return this.idle();
    this.close();
  },
  // Repo đang xem hết tab: khung trống liệt kê agent của repo; tab của repo khác giữ nguyên.
  idle() { this.close(true); this.save(); this.post(); this.renderEmpty(); },

  // Agent không còn trên canvas nào: bỏ tab, đang mở thì sang tab kế.
  dropTab(id) { if (this.tabs.includes(id)) this.closeTab(id); },

  // Nút +: mọi agent Claude / Codex trên các canvas; đang có tab thì đánh dấu.
  agentMenu(btn) {
    if (this.menu) return this.closeMenu();
    const all = this.agents.filter((x) => x.agent !== 'shell'), list = all.filter((x) => this.mine(x)), rest = all.filter((x) => !this.mine(x));
    const item = (x) => h(`button.menu-item${x.nodeId === this.a?.nodeId ? '.on' : ''}`, { type: 'button', title: x.cwd,
      onclick: () => { this.closeMenu(); this.open(x.nodeId); } },
      h(`span.dock-mk.${x.agent}`, x.agent === 'codex' ? 'X' : 'C'),
      h('span.grow', h('span', x.title), h('span.sub', `${x.projectName} › ${x.canvasName}`)),
      h(`span.status-dot.${x.status}`),
      this.tabs.includes(x.nodeId) ? icon('check') : null);
    const m = h('div.menu.dock-agent-menu', { onmousedown: (e) => e.stopPropagation() },
      h('div.menu-hd', this.roots.length ? 'Agents in this repository' : 'Open an agent'),
      ...(list.length ? list.map(item) : [h('div.menu-empty', all.length ? 'No agent works in this repository yet.' : 'No Claude or Codex agent on any canvas yet.')]),
      ...(this.roots.length && rest.length ? [h('div.menu-sep'), h('div.menu-hd', 'Other repositories'), ...rest.map(item)] : []));
    document.body.append(m);
    const r = btn.getBoundingClientRect();
    m.style.position = 'fixed';
    m.style.top = `${r.bottom + 4}px`;
    m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8))}px`;
    this.menu = m;
    this.menuOff = (e) => { if (e.type === 'keydown' ? e.key === 'Escape' : !m.contains(e.target)) this.closeMenu(); };
    addEventListener('mousedown', this.menuOff, true); addEventListener('keydown', this.menuOff, true); addEventListener('blur', this.menuOff);
  },

  closeMenu() {
    this.menu?.remove(); this.menu = null;
    removeEventListener('mousedown', this.menuOff, true); removeEventListener('keydown', this.menuOff, true); removeEventListener('blur', this.menuOff);
  },

  // Hạn mức: proxy AI Hub đọc header anthropic-ratelimit-unified-* của lượt gần nhất (gói Pro / Max).
  // Khóa API / gateway không trả các header đó — khi ấy chỉ hiện token / chi phí AI Hub đã ghi.
  async loadQuota() {
    clearTimeout(this.quotaT);
    if (!this.live || !this.a) return;
    try { this.usage = await window.menorah.hubUsage(this.a.agent === 'claude' ? this.a.sessionId : ''); } catch { this.usage = null; }
    this.paintQuota(this.usage);
    if (this.live) this.quotaT = setTimeout(() => this.loadQuota(), QUOTA_MS);
  },

  paintQuota(u) {
    if (!this.quota) return;
    const kids = [];
    if (this.a?.agent !== 'claude') { this.quota.replaceChildren(); return; }
    if (!u) { this.quota.replaceChildren(); return; }
    if (!u.proxy) {
      kids.push(h('button.dock-q-hint', { type: 'button', title: 'Usage and plan limits are read by the AI Hub proxy. Turn on the Inference Router in AI Hub, then resume the session.',
        onclick: () => this.app.setView('hub') }, 'Usage: turn on AI Hub'));
      this.quota.replaceChildren(...kids);
      return;
    }
    const L = u.limits;
    const stale = L && Date.now() - L.at > 5 * 3600e3;
    for (const [k, w] of L && !stale ? [['5h', L.h5], ['7d', L.d7]] : []) {
      if (!w) continue;
      const pct = Math.max(0, Math.min(100, Math.round(w.util * 100)));
      const lvl = w.status === 'rejected' || pct >= 90 ? '.hot' : pct >= 70 ? '.warn' : '';
      const reset = w.reset ? ` · resets ${untilText(w.reset * 1000)}` : '';
      kids.push(h(`span.dock-q${lvl}`, { title: `${k === '5h' ? '5-hour' : 'Weekly'} plan limit: ${pct}% used${reset}\nUpdated ${timeAgo(L.at)} from the last Claude reply` },
        h('b', k), h('span.dock-q-bar', h('i', { style: `width:${pct}%` })), `${pct}%`));
    }
    if (L && !stale && L.status === 'rejected') kids.unshift(h('span.dock-q.hot', { title: L.reset ? `Resets ${untilText(L.reset * 1000)}` : '' }, 'Limit reached'));
    const s = u.session;
    if (s?.n) kids.push(h('span.dock-q.use', { title: `This session, recorded by AI Hub: ${s.n} requests · ${fmtTokens(s.tokens || 0)} tokens · ${fmtUsd(s.cost)} at API prices` },
      `${fmtTokens(s.tokens || 0)} · ${fmtUsd(s.cost)}`));
    if (u.today?.n) kids.push(h('span.dock-q.use', { title: `Today across every Claude Code session through AI Hub: ${u.today.n} requests · ${fmtTokens(u.today.tokens || 0)} tokens` },
      `Today ${fmtUsd(u.today.cost)}`));
    if (!kids.length) kids.push(h('span.dock-q.use', { title: 'Plan limits (5-hour / weekly) show after the next reply when Claude Code is signed in with a Claude plan. API keys and gateways do not report them.' }, 'No usage yet'));
    this.quota.replaceChildren(...kids);
  },

  paintFollow() {
    this.followBtn.classList.toggle('on', this.follow);
    this.followBtn.title = this.follow ? 'Follow is on — the diff of each file the agent edits opens in Project. Click to turn off.'
      : 'Follow is off — click to open the diff of each file the agent edits';
  },

  // Sau mỗi lần ChatView vẽ: báo git.html danh sách tệp đã sửa; lần sửa mới (không phải lần vẽ đầu,
  // lúc đọc lại lịch sử) thì mở diff của tệp đó nếu Follow bật.
  files({ paths, latest = [], last }) {
    const sig = paths.join('\n') + '\0' + latest.join('\n');
    if (sig !== this.sig) { this.sig = sig; this.paths = paths; this.latest = latest; this.post(); }
    // Có lượt trả lời mới: hạn mức đổi theo, đọc lại sớm thay vì chờ chu kỳ.
    if (this.live && this.a?.agent === 'claude') { clearTimeout(this.quotaT); this.quotaT = setTimeout(() => this.loadQuota(), 1500); }
    const id = last?.id || null;
    if (this.last !== undefined && id && id !== this.last && this.follow) this.app.reviewFile(last.path, { follow: true });
    this.last = id;
  },

  post() { this.app.postGit({ type: 'menorah:dock', nodeId: this.a?.nodeId || null, paths: this.paths, latest: this.latest || [] }); },

  // Danh sách agent định kỳ (3 giây, khi đang ở tab Project): cập nhật trạng thái, tên; agent bị
  // xoá khỏi canvas thì đóng; lần đầu thì mở lại agent đã mở trước khi tắt app.
  update(agents) {
    this.agents = agents;
    const ids = new Set(agents.filter((x) => x.agent !== 'shell').map((x) => x.nodeId));
    const gone = this.tabs.filter((id) => !ids.has(id) && id !== this.a?.nodeId);
    if (gone.length) { this.tabs = this.tabs.filter((id) => !gone.includes(id)); this.save(); }
    if (!this.a) {
      if (this.want) return this.choose();
      if (this.emptySigOf() !== this.emptySig) this.renderEmpty();
      return;
    }
    const a = agents.find((x) => x.nodeId === this.a.nodeId);
    if (!a) return this.closeTab(this.a.nodeId);
    this.a = a;
    if (this.tabSigOf() !== this.tabSig) this.renderTabs();
    this.stopped.hidden = a.status !== 'stopped';
    this.chat.setState(a.status);
  },

  // git.html đổi chế độ (Graph | Files | IDE), đổi repo / worktree hay tải lại trang.
  mode(ide, roots) {
    this.ide = !!ide;
    if (this.ide && roots && roots.join('\n') !== this.roots.join('\n')) {
      this.roots = roots;
      if (!this.a || !this.mine(this.a)) this.choose();
      else if (this.tabsEl) this.renderTabs();
    }
    this.sync();
  },
  // Chọn agent cho repo đang xem: agent nhớ từ lần trước (khởi động) nếu thuộc repo, rồi agent mở gần
  // nhất ở repo này, rồi tab đầu tiên của repo. Không có thì khung trống. Danh sách agent chưa về: chờ update().
  choose() {
    if (!this.agents.length) return;
    const by = new Map(this.agents.filter((x) => x.agent !== 'shell').map((x) => [x.nodeId, x]));
    const ok = (id) => !!id && by.has(id) && this.mine(by.get(id));
    const tabs = this.tabs.filter(ok), last = this.lastBy[this.roots[0]];
    const id = [this.want, tabs.includes(last) ? last : null, tabs[0]].find(ok);
    this.want = null;
    if (id) return this.open(id, { focus: false });
    if (this.a) return this.idle();
    if (this.emptySigOf() !== this.emptySig || !this.el.firstChild) this.renderEmpty();
  },

  // Khung chỉ hiện ở IDE; ChatView chỉ đọc transcript khi khung đang hiện ở tab Project.
  sync(focus = false) {
    this.el.hidden = this.rz.hidden = !this.ide;
    if (this.ide && !this.a && !this.el.firstChild) this.renderEmpty();
    const on = !!this.chat && this.ide && this.app.view === 'git';
    if (on === this.live) return;
    this.live = on;
    if (on) { this.chat.start(focus); this.loadQuota(); } else { this.chat.stop(); clearTimeout(this.quotaT); }
  },
};

// "in 2h 10m" / "in 3d" cho mốc reset hạn mức.
function untilText(ms) {
  const m = Math.round((ms - Date.now()) / 60000);
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m}m`;
  if (m < 48 * 60) return `in ${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `in ${Math.round(m / 1440)}d`;
}
