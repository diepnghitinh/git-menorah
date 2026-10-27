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
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#project-menu')) $('#project-menu').hidden = true;
      if (!e.target.closest('#canvas-menu')) $('#canvas-menu').hidden = true;
      if (!e.target.closest('#node-menu')) $('#node-menu').hidden = true;
    });
    $('#zoom-in').addEventListener('click', () => this.canvas.zoomBy(1.2));
    $('#zoom-out').addEventListener('click', () => this.canvas.zoomBy(1 / 1.2));
    $('#zoom-reset').addEventListener('click', () => { const r = $('#stage').getBoundingClientRect(); this.canvas.zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1); });
    $('#zoom-fit').addEventListener('click', () => this.canvas.fit());
    $('#resume-all').addEventListener('click', () => this.canvas.resumeAll());
    this.bindShots();
    this.bindGitFrame();
    // Bộ gõ của máy có thể vừa bật / tắt khi người dùng ở app khác: dò lại mỗi lần quay về.
    vnInput.probe();
    window.addEventListener('focus', () => vnInput.probe());
    vnInput.listen(() => this.postGit({ type: 'menorah:vnkey', ...vnInput.config() }));
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
    if (view === 'stats') { AIHub.tab = 'stats'; view = 'hub'; }   // bản cũ: Statistics là mục riêng trên rail
    if (!['canvas', 'git', 'hub', 'settings'].includes(view)) view = agents ? 'git' : 'canvas';
    this.view = view;
    $$('.rail-btn').forEach((t) => t.classList.toggle('on', t.dataset.view === view));
    for (const v of ['canvas', 'git', 'hub', 'settings']) $(`#view-${v}`).hidden = v !== view;
    if (view === 'hub' || view === 'settings') AIHub.show(view);
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
  // Breadcrumb của canvas: [project ▾] / tab 1 · tab 2 … Chưa có project thì chỉ còn nút chọn thư mục.
  renderCanvasTabs() {
    const bar = $('#canvas-tabs'), crumb = $('#canvas-crumb');
    const pick = (e) => { e.stopPropagation(); this.toggleProjectMenu(e.currentTarget); };
    if (!this.project) {
      crumb.replaceChildren(h('button.cproj.empty', { title: 'Open a project folder or repository', onclick: pick }, icon('folder'), h('span', 'Select Folder Project')));
      bar.replaceChildren();
      return;
    }
    crumb.replaceChildren(
      h('button.cproj', { title: `${this.project.name}\n${this.project.cwd}\nClick to switch project`, onclick: pick },
        icon('folder'), h('span.cproj-name', this.project.name), icon('chev', 'chev')),
      h('span.crumb-sep', '/'));
    const many = this.project.canvases.length > 1;
    bar.replaceChildren(...this.project.canvases.map((c) => {
      const tab = h(`div.ctab${c.id === this.project.canvasId ? '.on' : ''}`, { role: 'tab', dataset: { id: c.id }, title: `${c.cwd || this.project.cwd}\nDouble-click to rename`,
        onclick: () => this.openCanvas(c.id), ondblclick: () => this.renameCanvas(c, tab) },
        h('span.ctab-name', c.name), h('span.ctab-n'),
        many ? h('span.ctab-x', { title: 'Close tab', onclick: (e) => { e.stopPropagation(); this.removeCanvas(c); } }, icon('close')) : null);
      return tab;
    }), h('button.ctab-add', { title: 'New tab', onclick: (e) => { e.stopPropagation(); this.toggleCanvasMenu(e.currentTarget); } }, icon('plus')));
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

  // + in the tab strip: a new tab on a folder picked by hand, on a fresh clone, or on a repository
  // already listed in the Git tab. Agents opened in that tab run in its folder.
  async toggleCanvasMenu(btn) {
    const m = $('#canvas-menu');
    $('#project-menu').hidden = true;
    if (!m.hidden) { m.hidden = true; return; }
    const repos = await window.menorah.repos();
    // Inside the project folder: show the part after it; outside: shorten $HOME to ~.
    const short = (p) => (p.startsWith(this.project.cwd + '/') ? p.slice(this.project.cwd.length + 1) : p.replace(this.info.home, '~'));
    const item = (ic, label, sub, act) => h('button.menu-item', { title: sub || null, onclick: () => { m.hidden = true; act(); } },
      icon(ic), h('span.grow', h('span', label), sub ? h('span.sub', short(sub)) : null));
    const { filter, list } = this.repoPicker(m, repos, (r) => item('branch', r.name, r.path, () => this.addCanvas({ cwd: r.path, name: r.name })));
    m.replaceChildren(...[
      h('div.menu-hd', 'New tab'),
      item('folder', 'Open Folder…', '', () => this.addCanvas({ pick: true })),
      item('download', 'Clone from URL…', '', () => this.cloneRepo({ tab: true })),
      repos.length && h('div.menu-sep'),
      repos.length && h('div.menu-hd', 'Repositories'),
      filter,
      repos.length && list,
    ].filter(Boolean));
    this.placeMenu(m, btn);
    filter?.focus();
  },

  // Danh sách repo của tab Project trong một menu; nhiều hơn 8 repo thì có ô lọc (Enter mở repo đầu tiên còn hiện).
  repoPicker(m, repos, itemOf) {
    const list = h('div.menu-list', ...repos.map((r) => {
      const it = itemOf(r);
      it.dataset.q = `${r.name} ${r.path}`.toLowerCase();
      return it;
    }));
    const filter = repos.length <= 8 ? null : h('input.menu-filter', { type: 'text', placeholder: 'Filter repositories…', spellcheck: false,
      oninput: (e) => { const q = e.target.value.trim().toLowerCase(); for (const it of list.children) it.hidden = !!q && !it.dataset.q.includes(q); },
      onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Escape') m.hidden = true; if (e.key === 'Enter') [...list.children].find((it) => !it.hidden)?.click(); } });
    return { filter, list };
  },

  placeMenu(m, btn) {
    const r = btn.getBoundingClientRect();
    m.hidden = false;
    m.style.top = `${r.bottom + 6}px`;
    m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`;
  },

  async addCanvas(opts = {}) {
    let p;
    try { p = await window.menorah.addCanvas(this.project.id, opts); }
    catch (e) { return toast(errText(e)); }
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
    const ok = await confirmBox(`Close ${c.name}?`, live
      ? `${live} running session${live > 1 ? 's' : ''} in this tab will be stopped. Claude Code and Codex keep their history — resume with claude --resume / codex resume.`
      : 'The nodes in this tab will be removed. Your folders and repositories are not touched.', 'Close tab', true);
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
    document.title = `${this.project.name} · GitMenorah`;
    await this.canvas.load(this.project, r.canvas, this.project.canvasId);
    if (!r.canvas.nodes?.length) this.canvas.applyViewport();
    this.renderCanvasTabs();
    return true;
  },

  showNoProject() {
    this.project = null;
    $('#canvas-empty').hidden = true;
    $('#rail-running').hidden = true;
    this.renderCanvasTabs();
  },

  async addProject(dir) {
    const p = await window.menorah.addProject(dir);
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

  // Đổi project, hoặc tạo board mới: chọn folder bằng tay, hay một repo trong tab Project chưa thành board.
  async toggleProjectMenu(btn) {
    const m = $('#project-menu');
    $('#canvas-menu').hidden = true;
    if (!m.hidden) { m.hidden = true; return; }
    const opened = new Set(this.projects.map((p) => p.cwd));
    const repos = (await window.menorah.repos()).filter((r) => !opened.has(r.path));
    const { filter, list } = this.repoPicker(m, repos, (r) => h('button.menu-item', { title: r.path, onclick: () => { m.hidden = true; this.addProject(r.path); } },
      icon('branch'), h('span.grow', h('span', r.name), h('span.sub', r.path.replace(this.info.home, '~')))));
    m.replaceChildren(...[
      ...this.projects.map((p) => h(`button.menu-item${p.id === this.project?.id ? '.on' : ''}`, { onclick: async () => { m.hidden = true; await this.openProject(p.id); } },
        h('span.grow', h('span', p.name), h('span.sub', { title: p.cwd }, p.cwd.replace(this.info.home, '~'))),
        h('span.x', { title: 'Remove from list', onclick: (e) => { e.stopPropagation(); m.hidden = true; this.removeProject(p); } }, icon('close')))),
      this.projects.length && h('div.menu-sep'),
      h('button.menu-item', { onclick: () => { m.hidden = true; this.addProject(); } }, icon('plus'), h('span.grow', 'Open Folder…')),
      repos.length && h('div.menu-sep'),
      repos.length && h('div.menu-hd', 'From the Project tab'),
      filter,
      repos.length && list,
    ].filter(Boolean));
    this.placeMenu(m, btn);
    filter?.focus();
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
      case 'settings': return this.openSettings(cmd.tab);
      case 'clone': return this.cloneRepo({ tab: this.view === 'canvas' });
    }
  },

  // ─── Settings: Accounts · Terminal limits ──────────────────────────────
  // One dialog with a tab per section. A pane renders into `body` and returns its cleanup.
  async openSettings(tab = 'accounts') {
    if (!$('#modal').hidden) return;
    let cleanup = null;
    await modal((d, close) => {
      d.classList.add('settings');
      const panes = {
        accounts: ['Accounts', (b) => this.accountsPane(b, close)],
        limits: ['Terminal limits', (b) => this.limitsPane(b, close)],
        vietnamese: ['Vietnamese typing', (b) => this.vnPane(b, close)],
      };
      const tabs = h('div.set-tabs', { role: 'tablist' });
      const body = h('div.set-body');
      const show = async (k) => {
        cleanup?.(); cleanup = null;
        for (const b of tabs.children) b.classList.toggle('on', b.dataset.k === k);
        body.replaceChildren();
        cleanup = await panes[k][1](body);
      };
      tabs.append(...Object.entries(panes).map(([k, [label]]) => h('button', { role: 'tab', dataset: { k }, onclick: () => show(k) }, label)));
      d.append(h('h3', 'Settings'), tabs, body);
      show(panes[tab] ? tab : 'accounts');
    });
    cleanup?.();
  },

  // Git cloud accounts, like Sourcetree's: a personal access token per account. The Git server
  // checks it with the provider and hands it to git's credential helper (Keychain…), so fetch,
  // push and clone use it — here and in every terminal. GitMenorah keeps no copy.
  async accountsPane(body, close) {
    const SVC = {
      github: { label: 'GitHub', host: 'github.com', mark: 'GH',
        token: (host) => `https://${host}/settings/tokens/new?description=GitMenorah&scopes=repo,read:org,workflow`,
        help: 'A classic token with the repo and read:org scopes (add workflow to push GitHub Actions files), or a fine-grained token with Contents read and write.' },
      gitlab: { label: 'GitLab', host: 'gitlab.com', mark: 'GL',
        token: (host) => `https://${host}/-/user_settings/personal_access_tokens?name=GitMenorah&scopes=read_api,read_repository,write_repository`,
        help: 'A personal access token with the read_api, read_repository and write_repository scopes.' },
      bitbucket: { label: 'Bitbucket', host: 'bitbucket.org', mark: 'BB',
        token: () => 'https://id.atlassian.com/manage-profile/security/api-tokens',
        help: 'An Atlassian API token with scopes for Bitbucket: read:user, read:workspace, read:repository and write:repository.' },
      other: { label: 'Other host', host: '', mark: '··', help: 'The username and password or token that host expects for git over HTTPS.' },
    };
    let st;
    const load = async () => { st = await window.menorah.accounts(); };
    const err = h('div.err');
    const fail = (e) => { err.textContent = errText(e); };
    const done = h('div.actions', h('button.primary', { onclick: () => close(true) }, 'Done'));

    const list = () => {
      const helperBox = st.helper
        ? h('p.help', `Tokens are stored by git's credential helper (${st.helper}), the same place git reads them from for fetch and push — in this app and in your terminals.`)
        : h('div.notice', h('b', 'Git has no credential helper'),
          h('span', 'Without one git cannot remember a token, so signing in would not last.'),
          st.suggestHelper ? h('button', { onclick: async () => {
            try { st = await window.menorah.accountsOp({ op: 'use-helper' }); list(); } catch (e) { fail(e); }
          } }, st.suggestHelper === 'osxkeychain' ? 'Use the macOS Keychain' : 'Use Git Credential Manager')
            : h('span.mono', 'git config --global credential.helper <helper>'));
      const row = (a) => {
        let armed = false;
        const rm = h('button', { onclick: async () => {
          if (!armed) { armed = true; rm.textContent = 'Sign out?'; rm.classList.add('danger'); return; }
          try { st = await window.menorah.accountsOp({ op: 'remove', id: a.id }); toast(`Signed out of ${a.label} (${a.username}).`); list(); } catch (e) { fail(e); }
        } }, 'Sign out');
        return h('div.acct', h(`span.acct-mark.${a.service}`, SVC[a.service]?.mark || '··'),
          h('div.grow', h('b', a.name || a.username), h('span.sub', `${a.name ? `${a.username} · ` : ''}${a.host} · clones over ${a.protocol.toUpperCase()}`)), rm);
      };
      body.replaceChildren(
        h('p', 'Sign in to GitHub, GitLab or Bitbucket to clone, fetch and push over HTTPS without typing passwords, and to pick repositories when cloning.'),
        helperBox,
        st.accounts.length ? h('div.acct-list', ...st.accounts.map(row)) : h('div.acct-empty', 'No accounts yet.'),
        h('button', { onclick: form, disabled: !st.helper }, icon('plus'), ' Add account…'),
        err, done);
    };

    const form = () => {
      err.textContent = '';
      const service = h('select', ...Object.entries(SVC).map(([k, s]) => h('option', { value: k }, s.label)));
      const host = h('input', { type: 'text', spellcheck: false, placeholder: 'git.example.com' });
      const email = h('input', { type: 'text', spellcheck: false, placeholder: 'you@example.com' });
      const user = h('input', { type: 'text', spellcheck: false });
      const token = h('input', { type: 'password', spellcheck: false, autocomplete: 'off' });
      const proto = h('select', h('option', { value: 'https' }, 'HTTPS'), h('option', { value: 'ssh' }, 'SSH (uses your SSH key)'));
      const link = h('a', { target: '_blank' });
      const help = h('div.help');
      const f = (label, input, note) => h('label.field', h('span', label), input, note || null);
      const hostF = f('Host', host, h('div.help', 'For GitHub Enterprise or a self-hosted GitLab, enter its address.'));
      const emailF = f('Atlassian account email', email);
      const userF = f('Username', user);
      const tokenF = f('Token', token, h('div', help, link));
      const sync = () => {
        const s = SVC[service.value];
        if (!host.dataset.edited) host.value = s.host;
        hostF.hidden = service.value === 'bitbucket';
        emailF.hidden = service.value !== 'bitbucket';
        userF.hidden = service.value !== 'other';
        tokenF.querySelector('span').textContent = service.value === 'other' ? 'Password or token' : 'Personal access token';
        help.textContent = s.help;
        const h_ = host.value.trim() || s.host;
        link.hidden = !s.token || !h_;
        if (s.token) { link.href = s.token(h_); link.textContent = `Create a token on ${service.value === 'bitbucket' ? 'Atlassian' : h_} ↗`; }
      };
      host.addEventListener('input', () => { host.dataset.edited = '1'; sync(); });
      service.addEventListener('change', () => { delete host.dataset.edited; sync(); });
      const save = h('button.primary', { onclick: async () => {
        err.textContent = '';
        save.disabled = true; save.textContent = 'Checking…';
        try {
          st = await window.menorah.accountsOp({ op: 'add', service: service.value, host: host.value, email: email.value, username: user.value, token: token.value, protocol: proto.value });
          toast(`Signed in to ${st.added.label} as ${st.added.username}.`);
          list();
        } catch (e) { fail(e); save.disabled = false; save.textContent = 'Sign in'; }
      } }, 'Sign in');
      body.replaceChildren(
        h('p', 'The token is checked with the provider, then stored by git\'s credential helper.'),
        f('Service', service), hostF, emailF, userF, tokenF, f('Clone over', proto),
        err,
        h('div.actions', h('button', { onclick: list }, 'Back'), save));
      body.onkeydown = (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); save.click(); } };
      sync();
      service.focus();
    };

    try { await load(); list(); } catch (e) { body.replaceChildren(h('p.err', errText(e)), done); }
    return () => { body.onkeydown = null; };
  },

  // CPU / RAM caps for every terminal. Saved in userData/settings.json (key `limits`); the
  // backend measures every second and throttles or stops child processes.
  async limitsPane(body, close) {
    let st = await window.menorah.limits();
    const num = (n, d = 1) => n.toLocaleString('en-US', { maximumFractionDigits: d });
    const field = (label, value, max, help) => {
      // Text, not type=number: Chrome's number box drops a value typed as "2,5".
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
    const save = async () => {
      try {
        const cpu = read(cpuIn, st.cores, 'CPU');
        const ram = read(ramIn, Math.floor(totalGb), 'RAM');
        await window.menorah.setLimits({ cpu, ramMb: Math.round(ram * 1024) });
        close(true);
        toast(cpu || ram ? 'Terminal limits saved.' : 'Terminal limits removed.');
      } catch (e) { err.textContent = e.message; }
    };
    body.replaceChildren(
      h('p', 'Shared by every terminal: agents on the canvas and the Terminal tray of the Git tab. Over the CPU limit, child processes (builds, tests…) are throttled. Over the RAM limit, the largest child process is stopped. Shells and agents themselves are never throttled or stopped.'),
      ...(st.supported ? [] : [h('p.err', 'Windows cannot throttle or stop processes yet — usage is shown only.')]),
      cpuField, ramField, now, err,
      h('div.actions',
        h('button', { onclick: () => close(false) }, 'Cancel'),
        h('button.primary', { disabled: !st.supported, onclick: save }, 'Save')),
    );
    body.onkeydown = (e) => { if (e.key === 'Enter' && st.supported) { e.preventDefault(); save(); } };
    cpuIn.focus();
    return () => { clearInterval(poll); body.onkeydown = null; };
  },

  // Gõ tiếng Việt trong terminal (app/vnkey.js). Đổi là lưu ngay, mọi terminal dùng luôn.
  async vnPane(body, close) {
    const c = vnInput.cfg, keys = this.info.platform === 'darwin' ? '⌃⇧ (Control + Shift)' : 'Ctrl + Shift';
    const status = h('div.limit-now');
    const paint = () => {
      status.textContent = vnInput.cfg.method === 'off' ? 'Built-in Vietnamese typing is off.'
        : vnInput.system ? `${vnInput.system} is running on this computer${vnInput.cfg.auto ? ' — the built-in typing stays off while it runs.' : '. Turn it off (or switch it to English) so the two do not add tone marks twice.'}`
        : vnInput.yielded() ? 'Another Vietnamese keyboard is typing in the terminal — the built-in typing paused. Press ' + keys + ' to take over again.'
        : `No Vietnamese keyboard app found — terminals use the built-in ${vnInput.cfg.method === 'vni' ? 'VNI' : 'Telex'} typing (${vnInput.cfg.on ? 'VI' : 'EN'} now).`;
    };
    const method = h('select', { onchange: () => vnInput.set({ method: method.value, on: true }) },
      [['off', 'Off'], ['telex', 'Telex — aa â · dd đ · s f r x j tones'], ['vni', 'VNI — 6 ^ · 7 ơ ư · 8 ă · 9 đ · 1–5 tones']]
        .map(([v, label]) => h('option', { value: v, selected: c.method === v }, label)));
    const check = (key, label) => h('label.check', h('input', { type: 'checkbox', checked: c[key], onchange: (e) => vnInput.set({ [key]: e.target.checked }) }), h('span', label));
    const off = vnInput.listen(paint);
    paint();
    vnInput.probe();
    body.replaceChildren(
      h('p', `Type Vietnamese straight into terminals and agent prompts, without a keyboard app. Press ${keys} in a terminal, or click VI / EN on its title bar, to switch between Vietnamese and English.`),
      h('label.field', h('span', 'Typing method'), method),
      check('auto', 'Turn off when this computer already has a Vietnamese keyboard (UniKey, OpenKey, EVKey, GoTiengViet, XKey, macOS Vietnamese input…)'),
      check('modern', 'Place tone marks the new way: hoà, thuỷ (instead of hòa, thủy)'),
      status,
      h('div.actions', h('button.primary', { onclick: () => close(true) }, 'Done')),
    );
    return off;
  },

  // ─── Clone from URL ─────────────────────────────────────────────────────
  // Paste a URL or pick a repository from a signed-in account. The Git server runs `git clone`
  // in the background and adds the result to the Git tab; `tab` also opens a canvas tab on it.
  async cloneRepo({ tab = false } = {}) {
    if (!$('#modal').hidden) return;
    let st;
    try { st = await window.menorah.accounts(); } catch (e) { return toast(errText(e)); }
    const nameOf = (u) => (u.replace(/[?#].*$/, '').replace(/\/+$/, '').split(/[/:]/).pop() || '').replace(/\.git$/i, '');
    const hostOf = (u) => (u.match(/^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)/i) || u.match(/^[^@/\s]+@([^:/\s]+):/) || [])[1]?.toLowerCase() || '';
    const job = await modal((d, close) => {
      d.classList.add('clone');
      const url = h('input', { type: 'text', spellcheck: false, placeholder: 'https://github.com/owner/repo.git  or  git@github.com:owner/repo.git' });
      const parent = h('input', { type: 'text', spellcheck: false, value: (st.cloneDir || this.project?.cwd || this.info.home).replace(this.info.home, '~') });
      const name = h('input', { type: 'text', spellcheck: false, placeholder: 'repo' });
      const as = h('select');
      const asF = h('label.field', h('span', 'Sign in as'), as);
      const cmd = h('div.cmd.mono');
      const err = h('div.err');
      const go = h('button.primary', 'Clone');

      // Repositories of the signed-in accounts: pick one to fill the URL.
      const acctSel = h('select', ...st.accounts.filter((a) => a.service !== 'other').map((a) => h('option', { value: a.id }, `${a.label} · ${a.username}`)));
      const q = h('input', { type: 'text', spellcheck: false, placeholder: 'Filter…' });
      const repoList = h('div.repo-list');
      let repos = [];
      const paintRepos = () => {
        const s = q.value.trim().toLowerCase();
        const hits = repos.filter((r) => !s || r.name.toLowerCase().includes(s)).slice(0, 200);
        repoList.replaceChildren(...(hits.length ? hits.map((r) => h('button.repo', { title: r.description || r.name, onclick: (e) => {
          const a = st.accounts.find((x) => x.id === acctSel.value);
          url.value = (a?.protocol === 'ssh' && r.ssh) || r.https;
          name.dataset.edited = ''; sync(); as.value = a?.protocol === 'ssh' ? '' : a?.id || '';
          for (const b of repoList.children) b.classList.toggle('on', b === e.currentTarget);
        } }, h('span.grow', r.name), r.private ? h('span.tag', 'private') : null)) : [h('div.muted', repos.length ? 'No match.' : 'No repositories.')]));
      };
      const loadRepos = async () => {
        repoList.replaceChildren(h('div.muted', 'Loading…'));
        try { repos = (await window.menorah.accountsOp({ op: 'repos', id: acctSel.value })).repos; paintRepos(); }
        catch (e) { repoList.replaceChildren(h('div.err', errText(e))); }
      };
      acctSel.addEventListener('change', loadRepos);
      q.addEventListener('input', paintRepos);
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); repoList.querySelector('button.repo')?.click(); } });
      const browse = acctSel.options.length ? h('div.browse', h('div.browse-head', acctSel, q), repoList) : null;

      const target = () => `${parent.value.trim().replace(/^~(?=\/|$)/, this.info.home).replace(/\/+$/, '')}/${name.value.trim()}`;
      const sync = () => {
        const u = url.value.trim();
        if (!name.dataset.edited) name.value = nameOf(u);
        // An account on the URL's host signs the clone in (HTTPS only; SSH uses your key).
        const host = hostOf(u);
        const mine = /^https:/i.test(u) ? st.accounts.filter((a) => a.host === host) : [];
        const keep = as.value;
        as.replaceChildren(...mine.map((a) => h('option', { value: a.id }, `${a.username} (${a.label})`)), h('option', { value: '' }, 'No account — use git\'s own credentials'));
        as.value = mine.some((a) => a.id === keep) ? keep : mine[0]?.id || '';
        asF.hidden = !mine.length;
        cmd.textContent = u ? `git clone ${u} ${target().replace(this.info.home, '~')}` : '';
        cmd.hidden = !u;
      };
      url.addEventListener('input', sync);
      name.addEventListener('input', () => { name.dataset.edited = name.value ? '1' : ''; sync(); });
      parent.addEventListener('input', sync);
      const pick = h('button', { onclick: async () => {
        const p = await window.menorah.pickDir({ title: 'Clone into this folder', from: parent.value.replace(/^~(?=\/|$)/, this.info.home) });
        if (p) { parent.value = p.replace(this.info.home, '~'); sync(); }
      } }, 'Choose…');

      const start = async () => {
        err.textContent = '';
        go.disabled = true; go.textContent = 'Starting…';
        try { close(await window.menorah.clone({ url: url.value, parent: parent.value, name: name.value, account: asF.hidden ? '' : as.value })); }
        catch (e) { err.textContent = errText(e); go.disabled = false; go.textContent = 'Clone'; }
      };
      go.addEventListener('click', start);
      d.append(
        h('h3', 'Clone repository'),
        h('label.field', h('span', 'Repository URL'), url),
        browse ? h('div.field', h('span', 'Or pick from your accounts')) : h('p.help', 'Sign in under Settings → Accounts to pick from your GitHub, GitLab or Bitbucket repositories.'),
        browse,
        asF,
        h('div.row2', h('label.field.grow', h('span', 'Clone into'), h('div.row', parent, pick)), h('label.field', h('span', 'Folder name'), name)),
        cmd, err,
        h('div.actions', h('button', { onclick: () => close(null) }, 'Cancel'), go));
      d.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target !== q) { e.preventDefault(); start(); } });
      sync();
      if (browse) loadRepos();
      url.focus();
    });
    if (!job) return;
    toast(`Cloning into ${job.dir.replace(this.info.home, '~')}…`, 4000);
    const label = job.dir.split(/[\\/]/).pop();
    for (;;) {
      await new Promise((r) => setTimeout(r, 700));
      let s;
      try { s = await window.menorah.cloneStatus(job.id); } catch (e) { return toast(`Clone of ${label}: ${errText(e)}`, 8000); }
      if (!s.done) continue;
      if (!s.ok) return this.cloneFailed(label, s.error, job.cmd);
      toast(`Cloned ${label}.`);
      this.postGit({ type: 'menorah:repos-changed', dir: s.dir });
      if (!this.project) return this.addProject(s.dir);
      if (tab) return this.addCanvas({ cwd: s.dir, name: label });
      return;
    }
  },

  cloneFailed(label, error, cmd) {
    if (!$('#modal').hidden) return toast(`Clone of ${label} failed: ${error}`, 10000);
    modal((d, close) => d.append(h('h3', `Could not clone ${label}`), h('div.cmd.mono', cmd), h('pre.cmd-out', error),
      h('div.actions', h('button.primary', { onclick: () => close(true) }, 'OK'))));
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
        this.postGit({ type: 'menorah:vnkey', ...vnInput.config() });
        if (this.wantAgentsTab) this.postGit({ type: 'menorah:side', tab: 'agents' });
        this.pushAgents();
      } else if (m.type === 'menorah:open-node' && typeof m.nodeId === 'string') {
        this.goNode(String(m.projectId), m.nodeId, m.canvasId);
      } else if (m.type === 'menorah:new-agent' && ['claude', 'codex', 'shell'].includes(m.agent) && typeof m.cwd === 'string' && /^(\/|[A-Za-z]:[\\/])/.test(m.cwd)) {
        this.newNode(m.agent, m.cwd);
      } else if (m.type === 'menorah:clone') {
        this.cloneRepo({});
      } else if (m.type === 'menorah:side-tab') {
        this.wantAgentsTab = m.tab === 'agents';
      } else if (m.type === 'menorah:win-drag' && ['start', 'move', 'end'].includes(m.phase)) {
        window.menorah.winDrag(m.phase);
      } else if (m.type === 'menorah:win-zoom') {
        window.menorah.winZoom();
      } else if (m.type === 'menorah:theme' && ['auto', 'light', 'dark'].includes(m.mode)) {
        window.menorah.setTheme(m.mode);
      } else if (m.type === 'menorah:vnkey-toggle') {
        vnInput.toggle();
      } else if (m.type === 'menorah:vnkey-foreign') {
        vnInput.foreignSeen();
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

app.init().catch((e) => { console.error(e); toast(`Startup failed: ${e.message}`, 10000); });
