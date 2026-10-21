// Khung app: menu cấp 1 (Project → Git, Canvas), thanh trên (project, dải tab canvas), nạp
// project, nhận lệnh từ menu, nói chuyện với iframe Git (tab Agents ở cột trái của nó).
'use strict';

const GIT_TERM_ID = /^gk-term:[\w-]{1,40}$/;   // phiên shell ở khay Terminal của tab Git

const app = {
  info: null,
  project: null,
  projects: [],
  view: 'canvas',
  canvas: null,
  gitLoaded: false,
  gitReady: false,
  stats: {},

  async init() {
    this.info = await window.menorah.info();
    document.body.classList.toggle('win', this.info.platform === 'win32');
    // ⌘+ / ⌘− phóng cả trang, nhưng ba nút đèn do hệ điều hành vẽ thì không: rail co theo sẽ hẹp
    // hơn ba nút và đè lên header. Đổi mức zoom làm trang đổi cỡ (sự kiện resize), nên đo lại ở đó.
    const railZoom = () => document.documentElement.style.setProperty('--rail-z', String(1 / (window.menorah.zoomFactor() || 1)));
    railZoom();
    window.addEventListener('resize', railZoom);
    if (this.info.ptyError) toast(`Could not start menorah-agentd: ${this.info.ptyError}`, 8000);

    this.canvas = new Canvas({ info: this.info, onStatus: () => {}, onContextMenu: (e, at) => this.openNodeMenu(e, at) });

    $$('.rail-btn').forEach((t) => t.addEventListener('click', () => this.setView(t.dataset.view)));
    $$('[data-new]').forEach((b) => b.addEventListener('click', () => this.newNode(b.dataset.new)));
    $('#project-btn').addEventListener('click', (e) => { e.stopPropagation(); this.toggleProjectMenu(); });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#project-menu')) $('#project-menu').hidden = true;
      if (!e.target.closest('#canvas-menu')) $('#canvas-menu').hidden = true;
      if (!e.target.closest('#node-menu')) $('#node-menu').hidden = true;
    });
    $('#add-project-btn').addEventListener('click', () => this.addProject());
    $('#zoom-in').addEventListener('click', () => this.canvas.zoomBy(1.2));
    $('#zoom-out').addEventListener('click', () => this.canvas.zoomBy(1 / 1.2));
    $('#zoom-reset').addEventListener('click', () => { const r = $('#stage').getBoundingClientRect(); this.canvas.zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1); });
    $('#zoom-fit').addEventListener('click', () => this.canvas.fit());
    $('#resume-all').addEventListener('click', () => this.canvas.resumeAll());
    this.bindShots();
    this.bindGitFrame();
    setInterval(() => this.pollStats(), 2000);
    setInterval(() => this.pushAgents(), 3000);

    window.menorah.onCommand((cmd) => this.command(cmd));
    window.menorah.onLimitAlert((msg) => toast(msg, 8000));

    const q = new URLSearchParams(location.search);
    this.gitQuery = q.get('git') || '';
    const st = await window.menorah.projects();
    this.projects = st.projects;
    const start = this.projects.find((p) => p.id === st.lastId) || this.projects[0];
    if (start) await this.openProject(start.id);
    else this.showNoProject();
    this.setView(q.get('view') || 'canvas');
  },

  // ─── Menu cấp 1 ────────────────────────────────────────────────────────
  // 'agents' (menu ⌘3, bản cũ) = màn Git mở sẵn tab Agents ở cột trái.
  setView(view) {
    const agents = view === 'agents';
    if (!['canvas', 'git'].includes(view)) view = agents ? 'git' : 'canvas';
    this.view = view;
    $$('.rail-btn').forEach((t) => t.classList.toggle('on', t.dataset.view === view));
    for (const v of ['canvas', 'git']) $(`#view-${v}`).hidden = v !== view;
    if (view === 'git' && !this.gitLoaded) {
      $('#git-frame').src = `${this.info.gitOrigin}/git.html?git=${encodeURIComponent(this.gitQuery)}`;
      this.gitLoaded = true;
    }
    if (agents) { this.wantAgentsTab = true; this.postGit({ type: 'menorah:side', tab: 'agents' }); }
    if (view === 'git') this.pushAgents();
    if (view === 'canvas') requestAnimationFrame(() => { for (const v of this.canvas.views.values()) v.fit?.(); });
  },

  // Badge: số phiên đang chạy trên từng canvas của project (dải tab) và tổng (icon Canvas).
  async pollStats() {
    if (!this.project || document.hidden) return;
    try { this.stats = await window.menorah.canvasStats(this.project.id); } catch { return; }
    const run = Object.values(this.stats).reduce((n, x) => n + x.running, 0);
    const el = $('#rail-running');
    el.hidden = !run; el.textContent = run;
    el.parentElement.title = run ? `Canvas (⌘2) · ${run} session${run > 1 ? 's' : ''} running` : 'Canvas (⌘2)';
    for (const t of $$('.ctab')) {
      const st = this.stats[t.dataset.id];
      const n = t.querySelector('.ctab-n');
      n.textContent = st?.total ? (st.running ? `${st.running}/${st.total}` : st.total) : '';
      n.classList.toggle('run', !!st?.running);
      n.title = st?.total ? `${st.total} terminal${st.total > 1 ? 's' : ''} · ${st.running} running` : '';
    }
  },

  // ─── Canvas trong project ───────────────────────────────────────────────
  renderCanvasTabs() {
    const bar = $('#canvas-tabs');
    if (!this.project) { bar.replaceChildren(); return; }
    const many = this.project.canvases.length > 1;
    bar.replaceChildren(...this.project.canvases.map((c) => {
      const tab = h(`div.ctab${c.id === this.project.canvasId ? '.on' : ''}`, { role: 'tab', dataset: { id: c.id }, title: `${c.cwd || this.project.cwd}\nDouble-click to rename`,
        onclick: () => this.openCanvas(c.id), ondblclick: () => this.renameCanvas(c, tab) },
        h('span.ctab-name', c.name), h('span.ctab-n'),
        many ? h('span.ctab-x', { title: 'Delete canvas', onclick: (e) => { e.stopPropagation(); this.removeCanvas(c); } }, icon('close')) : null);
      return tab;
    }), h('button.ctab-add', { title: 'New canvas', onclick: (e) => { e.stopPropagation(); this.toggleCanvasMenu(e.currentTarget); } }, icon('plus')));
    bar.querySelector('.ctab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.pollStats();
  },

  setProject(p) {
    this.project = p;
    const i = this.projects.findIndex((x) => x.id === p.id);
    if (i >= 0) this.projects[i] = p; else this.projects.push(p);
  },

  async openCanvas(canvasId) {
    if (!this.project || canvasId === this.project.canvasId) return;
    const r = await window.menorah.openCanvas(this.project.id, canvasId);
    this.setProject(r.project);
    await this.canvas.load(r.project, r.canvas, r.project.canvasId);
    if (!r.canvas.nodes?.length) this.canvas.applyViewport();
    this.renderCanvasTabs();
    this.setView('canvas');
  },

  // + ở dải tab: canvas mới ở thư mục project, ở một repo có sẵn ở tab Project (màn Git), hoặc thư mục chọn tay.
  // Agent mở trên canvas đó chạy trong thư mục ấy.
  async toggleCanvasMenu(btn) {
    const m = $('#canvas-menu');
    if (!m.hidden) { m.hidden = true; return; }
    const repos = (await window.menorah.repos()).filter((r) => r.path !== this.project.cwd);
    // Repo nằm trong project thì chỉ in phần sau thư mục project cho đỡ dài; ngoài project thì rút $HOME thành ~.
    const short = (p) => (p.startsWith(this.project.cwd + '/') ? p.slice(this.project.cwd.length + 1) : p.replace(this.info.home, '~'));
    const item = (ic, label, sub, opts) => h('button.menu-item', { onclick: () => { m.hidden = true; this.addCanvas(opts); } },
      icon(ic), h('span.grow', h('span', label), sub ? h('span.sub', { title: sub }, short(sub)) : null));
    m.replaceChildren(...[
      h('div.menu-hd', 'New canvas'),
      item('folder', 'Project folder', this.project.cwd, {}),
      repos.length && h('div.menu-hd', 'Repositories in Project'),
      repos.length && h('div.menu-list', ...repos.map((r) => item('branch', r.name, r.path, { cwd: r.path, name: r.name }))),
      h('div.menu-sep'),
      item('plus', 'Open Folder…', '', { pick: true }),
    ].filter(Boolean));
    const r = btn.getBoundingClientRect();
    m.hidden = false;
    m.style.top = `${r.bottom + 6}px`;
    m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`;
  },

  async addCanvas(opts = {}) {
    let p;
    try { p = await window.menorah.addCanvas(this.project.id, opts); }
    catch (e) { return toast(String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    if (!p) return;
    this.setProject({ ...p, canvasId: this.project.canvasId });
    await this.openCanvas(p.canvasId);
  },

  renameCanvas(c, tab) {
    const name = tab.querySelector('.ctab-name');
    const input = h('input', { type: 'text', value: c.name, spellcheck: false });
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (save && v && v !== c.name) this.setProject(await window.menorah.renameCanvas(this.project.id, c.id, v));
      this.renderCanvasTabs();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    name.replaceWith(input);
    input.focus(); input.select();
  },

  async removeCanvas(c) {
    const live = this.stats[c.id]?.live || 0;
    const ok = await confirmBox(`Delete ${c.name}?`, live
      ? `${live} running session${live > 1 ? 's' : ''} on this canvas will be stopped. Claude Code and Codex keep their history — resume with claude --resume / codex resume.`
      : 'The nodes on this canvas will be removed. Your folders and repositories are not touched.', 'Delete canvas', true);
    if (!ok) return;
    const wasOpen = c.id === this.project.canvasId;
    const p = await window.menorah.removeCanvas(this.project.id, c.id);
    if (wasOpen) {
      // Canvas đang mở vừa bị xoá: bỏ doc cũ (đừng lưu đè), nạp canvas còn lại.
      this.canvas.canvasId = null;
      const r = await window.menorah.openCanvas(this.project.id, p.canvasId);
      this.setProject(r.project);
      await this.canvas.load(r.project, r.canvas, r.project.canvasId);
    } else this.setProject(p);
    this.renderCanvasTabs();
  },

  // ─── Project ────────────────────────────────────────────────────────────
  async openProject(id) {
    if (this.project?.id === id) return true;
    const r = await window.menorah.openProject(id);
    if (r.elsewhere) { toast('This project is open in another window.'); return false; }
    this.setProject(r.project);
    $('#project-name').textContent = this.project.name;
    $('#project-btn').title = `${this.project.name}\n${this.project.cwd}\nClick to switch project`;
    $('#project-initial').textContent = initials(this.project.name);
    document.title = `${this.project.name} · GitMenorah`;
    $('#no-project').hidden = true;
    await this.canvas.load(this.project, r.canvas, this.project.canvasId);
    if (!r.canvas.nodes?.length) this.canvas.applyViewport();
    this.renderCanvasTabs();
    return true;
  },

  showNoProject() {
    this.project = null;
    $('#project-name').textContent = 'No project';
    $('#project-initial').textContent = '+';
    $('#project-btn').title = 'Open a project folder';
    $('#no-project').hidden = false;
    $('#canvas-empty').hidden = true;
    $('#rail-running').hidden = true;
    this.renderCanvasTabs();
  },

  async addProject() {
    const p = await window.menorah.addProject();
    if (!p) return;
    if (!this.projects.some((x) => x.id === p.id)) this.projects.push(p);
    await this.openProject(p.id);
    this.setView('canvas');
  },

  async removeProject(p) {
    const ok = await confirmBox(`Remove project ${p.name}?`, 'Its canvases and every session running on them will be closed. Your folders and repositories are not touched.', 'Remove project', true);
    if (!ok) return;
    const st = await window.menorah.removeProject(p.id);
    this.projects = st.projects;
    if (this.project?.id === p.id) {
      this.project = null;
      const next = this.projects.find((x) => x.id === st.lastId);
      if (next) await this.openProject(next.id);
      else { await this.canvas.load(null, {}); this.showNoProject(); }
    }
  },

  toggleProjectMenu() {
    const m = $('#project-menu');
    if (!m.hidden) { m.hidden = true; return; }
    m.replaceChildren(
      ...this.projects.map((p) => h(`button.menu-item${p.id === this.project?.id ? '.on' : ''}`, { onclick: async () => { m.hidden = true; await this.openProject(p.id); } },
        h('span.grow', h('span', p.name), h('span.sub', { title: p.cwd }, p.cwd.replace(this.info.home, '~'))),
        h('span.x', { title: 'Remove from list', onclick: (e) => { e.stopPropagation(); m.hidden = true; this.removeProject(p); } }, icon('close')))),
      this.projects.length ? h('div.menu-sep') : '',
      h('button.menu-item', { onclick: () => { m.hidden = true; this.addProject(); } }, icon('plus'), h('span.grow', 'Open Folder…')));
    m.hidden = false;
  },

  // Chuột phải trên nền canvas: tạo agent/terminal/ghi chú, góc trên trái node nằm ngay điểm bấm.
  // Đóng khi bấm ra ngoài, Esc, cuộn/zoom canvas hoặc chuột phải chỗ khác.
  openNodeMenu(e, at) {
    const m = $('#node-menu');
    const pos = { x: Math.round(at.x), y: Math.round(at.y) };
    const item = (mark, label, kbd, kind) => h('button.menu-item', { role: 'menuitem', onclick: () => { m.hidden = true; this.newNode(kind, undefined, pos); } },
      mark, h('span.grow', label), kbd ? h('span.menu-kbd', kbd) : null);
    const mk = (k, c) => h(`span.agent-mark.${k}`, c);
    m.replaceChildren(
      h('div.menu-hd', 'Add here'),
      item(mk('claude', 'C'), 'Claude Code', '⌘T', 'claude'),
      item(mk('codex', 'X'), 'Codex', '⇧⌘T', 'codex'),
      item(mk('shell', '$'), 'Terminal', '⌥⌘T', 'shell'),
      h('div.menu-sep'),
      item(icon('note'), 'Note', '', 'note'));
    $('#project-menu').hidden = true; $('#canvas-menu').hidden = true;
    m.hidden = false;
    m.style.left = `${Math.max(8, Math.min(e.clientX, innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${Math.max(8, Math.min(e.clientY, innerHeight - m.offsetHeight - 8))}px`;
    m.querySelector('.menu-item').focus();
    if (this.nodeMenuBound) return;
    this.nodeMenuBound = true;
    const close = () => { m.hidden = true; };
    m.addEventListener('keydown', (ev) => {
      const items = [...m.querySelectorAll('.menu-item')], i = items.indexOf(document.activeElement);
      if (ev.key === 'Escape') { close(); $('#stage').focus(); }
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      else return;
      ev.preventDefault(); ev.stopPropagation();
    });
    $('#stage').addEventListener('wheel', close, { capture: true, passive: true });
    document.addEventListener('contextmenu', (ev) => { if (!ev.target.closest('#stage')) close(); });
    window.addEventListener('blur', close);
  },

  // ─── Node ───────────────────────────────────────────────────────────────
  // cwd: thư mục làm việc (worktree). Thuộc project khác thì chuyển sang project chứa nó.
  // at: toạ độ world đặt góc trên trái node (menu chuột phải); bỏ trống thì đặt giữa khung nhìn.
  async newNode(kind, cwd, at) {
    if (!this.project) return this.addProject();
    if (cwd) {
      const inside = (p) => cwd === p.cwd || cwd.startsWith(p.cwd + '/');
      const owner = inside(this.project) ? this.project : this.projects.filter(inside).sort((a, b) => b.cwd.length - a.cwd.length)[0];
      if (owner && owner.id !== this.project.id && !(await this.openProject(owner.id))) return;
    }
    this.setView('canvas');
    if (kind === 'note') this.canvas.add({ kind: 'note', ...at });
    else this.canvas.add({ kind: 'terminal', agent: kind, ...at, cwd: cwd || this.canvas.rootCwd(), title: cwd && cwd !== this.canvas.rootCwd() ? `${AGENTS[kind].label} · ${cwd.split(/[\\/]/).pop()}` : undefined });
  },

  // Nhảy tới một node: chuyển project, rồi canvas chứa node đó (không biết canvas thì hỏi backend).
  async goNode(projectId, nodeId, canvasId) {
    if (projectId !== this.project?.id && !(await this.openProject(projectId))) return;
    if (!canvasId) canvasId = (await window.menorah.agents()).find((a) => a.nodeId === nodeId)?.canvasId;
    if (canvasId && canvasId !== this.project.canvasId) await this.openCanvas(canvasId);
    this.setView('canvas');
    requestAnimationFrame(() => this.canvas.focusNode(nodeId));
  },

  command(cmd) {
    switch (cmd.type) {
      case 'new-node': return this.newNode(cmd.kind === 'note' ? 'note' : cmd.agent);
      case 'view': return this.setView(cmd.view);
      case 'fit': this.setView('canvas'); return this.canvas.fit();
      case 'add-project': return this.addProject();
      case 'git-reload': if (this.gitLoaded) $('#git-frame').contentWindow.location.reload(); return;
      case 'focus-node': return this.goNode(cmd.projectId, cmd.nodeId, cmd.canvasId);
      case 'settings': return this.openSettings();
    }
  },

  // ─── Settings: giới hạn CPU / RAM chung cho mọi terminal ────────────────
  // Lưu ở userData/settings.json (khoá limits); backend đo mỗi giây và hãm / tắt tiến trình con.
  async openSettings() {
    if (!$('#modal').hidden) return;
    let st = await window.menorah.limits();
    const num = (n, d = 1) => n.toLocaleString('en-US', { maximumFractionDigits: d });
    const field = (label, value, max, help) => {
      // Ô chữ, không phải type=number: ô số của Chrome bỏ trống giá trị "2,5" (dấu phẩy kiểu Việt).
      const input = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'No limit', value: value ? num(value) : '', disabled: !st.supported });
      return [input, h('label.field', h('span', label), input, h('div.help', help))];
    };
    const totalGb = st.totalMb / 1024;
    const [cpuIn, cpuField] = field('Max CPU (cores)', st.limits.cpu, st.cores, `This machine has ${st.cores} cores. Leave empty for no limit.`);
    const [ramIn, ramField] = field('Max RAM (GB)', st.limits.ramMb ? +(st.limits.ramMb / 1024).toFixed(1) : 0, Math.floor(totalGb), `This machine has ${num(totalGb, 0)} GB. Leave empty for no limit.`);
    const now = h('div.limit-now');
    const err = h('div.err');
    const paint = () => {
      const u = st.usage;
      now.textContent = u.at
        ? `Terminals are using ${num(u.cpu)} cores · ${num(u.ramMb / 1024)} GB · ${u.procs} processes${u.duty < 1 ? ` · throttled, child processes run ${Math.round(u.duty * 100)}% of the time` : ''}`
        : 'Measuring usage…';
    };
    paint();
    const poll = setInterval(async () => { try { st = { ...st, usage: (await window.menorah.limits()).usage }; paint(); } catch {} }, 1500);
    const read = (input, max, what) => {
      const raw = input.value.trim();
      if (!raw) return 0;
      const v = /^\d+([.,]\d+)?$/.test(raw) ? Number(raw.replace(',', '.')) : NaN;
      if (!(v >= 0.5 && v <= max)) throw new Error(`${what} must be between 0.5 and ${num(max)}, or empty.`);
      return v;
    };
    const save = async (close) => {
      try {
        const cpu = read(cpuIn, st.cores, 'CPU');
        const ram = read(ramIn, Math.floor(totalGb), 'RAM');
        await window.menorah.setLimits({ cpu, ramMb: Math.round(ram * 1024) });
        close(true);
        toast(cpu || ram ? 'Terminal limits saved.' : 'Terminal limits removed.');
      } catch (e) { err.textContent = e.message; }
    };
    await modal((d, close) => {
      d.classList.add('settings');
      d.append(
        h('h3', 'Terminal resource limits'),
        h('p', 'Shared by every terminal: agents on the canvas and the Terminal tray of the Git tab. Over the CPU limit, child processes (builds, tests…) are throttled. Over the RAM limit, the largest child process is stopped. Shells and agents themselves are never throttled or stopped.'),
        ...(st.supported ? [] : [h('p.err', 'Windows cannot throttle or stop processes yet — usage is shown only.')]),
        cpuField, ramField, now, err,
        h('div.actions',
          h('button', { onclick: () => close(false) }, 'Cancel'),
          h('button.primary', { disabled: !st.supported, onclick: () => save(close) }, 'Save')),
      );
      d.addEventListener('keydown', (e) => { if (e.key === 'Enter' && st.supported) { e.preventDefault(); save(close); } });
    });
    clearInterval(poll);
  },

  // ─── iframe Git ─────────────────────────────────────────────────────────
  // git.html chạy ở server git (http://127.0.0.1:<cổng>), không có window.menorah. Nó báo
  // 'menorah:ready' khi nạp xong; app gửi danh sách agent định kỳ, nó gửi lại yêu cầu mở node
  // hoặc mở agent mới ở một worktree. Chỉ nhận tin từ đúng iframe đó và đúng origin.
  bindGitFrame() {
    const frame = $('#git-frame');
    window.addEventListener('message', (e) => {
      if (e.source !== frame.contentWindow || e.origin !== this.info.gitOrigin) return;
      const m = e.data || {};
      if (m.type === 'menorah:ready') {
        this.gitReady = true;
        if (this.wantAgentsTab) this.postGit({ type: 'menorah:side', tab: 'agents' });
        this.pushAgents();
      } else if (m.type === 'menorah:open-node' && typeof m.nodeId === 'string') {
        this.goNode(String(m.projectId), m.nodeId, m.canvasId);
      } else if (m.type === 'menorah:new-agent' && ['claude', 'codex', 'shell'].includes(m.agent) && typeof m.cwd === 'string' && /^(\/|[A-Za-z]:[\\/])/.test(m.cwd)) {
        this.newNode(m.agent, m.cwd);
      } else if (m.type === 'menorah:side-tab') {
        this.wantAgentsTab = m.tab === 'agents';
      } else if (m.type === 'menorah:win-drag' && ['start', 'move', 'end'].includes(m.phase)) {
        window.menorah.winDrag(m.phase);
      } else if (m.type === 'menorah:win-zoom') {
        window.menorah.winZoom();
      } else if (typeof m.type === 'string' && m.type.startsWith('menorah:term-')) {
        this.gitTerm(m);
      }
    });
    // Khay Terminal của tab Git: PTY vẫn ở tiến trình chính như node canvas, chỉ khác id
    // (gk-term:…) — iframe vẽ xterm, app chuyển chữ hai chiều. Canvas bỏ qua id lạ.
    window.menorah.onPtyData(({ nodeId, data }) => { if (GIT_TERM_ID.test(nodeId)) this.postGit({ type: 'menorah:term-data', id: nodeId, data }); });
    window.menorah.onPtyExit(({ nodeId, code }) => { if (GIT_TERM_ID.test(nodeId)) this.postGit({ type: 'menorah:term-exit', id: nodeId, code }); });
  },

  // Chỉ nhận id gk-term:… — iframe không ghi được vào phiên agent trên canvas.
  async gitTerm(m) {
    // Nạp lại trang: chỉ hỏi shell nào còn sống để nối lại, không mở shell mới.
    if (m.type === 'menorah:term-alive') {
      const ids = (Array.isArray(m.ids) ? m.ids : []).filter((id) => typeof id === 'string' && GIT_TERM_ID.test(id)).slice(0, 50);
      const st = ids.length ? await window.menorah.ptyState(ids) : {};
      return this.postGit({ type: 'menorah:term-alive', alive: ids.filter((id) => st[id] && st[id] !== 'stopped') });
    }
    if (!GIT_TERM_ID.test(m.id)) return;
    // cwd rỗng (đang ở màn Projects, chưa chọn repo) thì mở ở thư mục project.
    const cwd = m.cwd || this.project?.cwd;
    if (m.type === 'menorah:term-start' && typeof cwd === 'string' && /^(\/|[A-Za-z]:[\\/])/.test(cwd)) {
      try {
        const r = await window.menorah.ptyStart({ nodeId: m.id, agent: 'shell', cwd, cols: m.cols, rows: m.rows });
        this.postGit({ type: 'menorah:term-started', id: m.id, cwd, buffer: r.buffer });
      } catch (e) { this.postGit({ type: 'menorah:term-started', id: m.id, error: e.message }); }
    } else if (m.type === 'menorah:term-write' && typeof m.data === 'string') window.menorah.ptyWrite(m.id, m.data);
    else if (m.type === 'menorah:term-resize') window.menorah.ptyResize(m.id, m.cols | 0, m.rows | 0);
    else if (m.type === 'menorah:term-kill') window.menorah.ptyKill(m.id);
  },

  postGit(msg) {
    if (this.gitReady) $('#git-frame').contentWindow.postMessage(msg, this.info.gitOrigin);
  },

  async pushAgents() {
    if (!this.gitReady || this.view !== 'git' || document.hidden) return;
    try { this.postGit({ type: 'menorah:agents', agents: await window.menorah.agents(), project: this.project?.id || null }); } catch {}
  },

  // ─── Ảnh vừa chụp ───────────────────────────────────────────────────────
  bindShots() {
    const pop = $('#shots');
    $('#shots-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!pop.hidden) { pop.hidden = true; return; }
      const list = $('#shots-list');
      list.replaceChildren(h('p.muted', 'Searching…'));
      pop.hidden = false;
      const shots = await window.menorah.shots();
      if (!shots.length) { list.replaceChildren(h('p.muted', 'No screenshots in the last 3 days.')); return; }
      list.replaceChildren(...shots.map((s) => {
        const img = h('img', { alt: s.name, draggable: true });
        window.menorah.thumb(s.path).then((u) => { if (u) img.src = u; });
        const card = h('div.shot', { title: `${s.name}\nDrag into a terminal, or click to place it on the canvas`, draggable: true }, img, h('span', timeAgo(s.mtime)));
        card.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('application/x-menorah-path', s.path); ev.dataTransfer.effectAllowed = 'copy'; setTimeout(() => { pop.hidden = true; }, 0); });
        card.addEventListener('click', () => { pop.hidden = true; this.canvas.add({ kind: 'image', path: s.path, title: s.name }); });
        return card;
      }));
    });
    document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !e.target.closest('#shots, #shots-btn')) pop.hidden = true; });
  },
};

// Chữ viết tắt cho ô project ở rail: "my-app.web" → "MA", "proj" → "PR".
function initials(name) {
  const w = String(name).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || '?').slice(0, 2)).toUpperCase();
}

app.init().catch((e) => { console.error(e); toast(`Startup failed: ${e.message}`, 10000); });
