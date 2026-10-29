// AI Hub (Inference Router + báo cáo Luồng đi) và Settings (nhà cung cấp AI). Trạng thái nằm ở
// tiến trình chính (workspace/ai-hub.cjs); trang này chỉ vẽ và gửi thay đổi. Khóa API đi một chiều:
// gõ vào → main mã hóa bằng Keychain, trang chỉ thấy "đã lưu …abcd".
'use strict';

const HUB_TASK_LABEL = {
  main: 'Main loop', small: 'Side request', explore: 'Explore (read many files)', safety: 'Safety check',
  judge: 'Router judging', unmatched: 'No task matched', unclassified: 'Unclassified', subagent: 'Subagent',
};
const HUB_ROUTER_LABEL = { tasks: 'Task table', se: 'Software Engineering', ai: 'AI Engineer', direct: 'No router' };
const NOT_RECORDED = 'Route not recorded';
const OUTSIDE = 'outside';   // project của lượt từ Claude Code ngoài app (qua ~/.claude/settings.json)
const fmtInt = (n) => Math.round(n || 0).toLocaleString('en-US');
const fmtPct = (x) => `${(x * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
const fmtUsd = (x) => `$${(x || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: x && x < 1 ? 4 : 2 })}`;
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 })}M` : n >= 1e4 ? `${(n / 1e3).toLocaleString('en-US', { maximumFractionDigits: 0 })}K` : fmtInt(n));

const AIHub = {
  st: null,
  metric: 'n',
  routerOpen: null,     // router đang mở trang chi tiết trong tab Router (null = danh sách)
  days: 7,
  project: '',          // lọc Luồng đi: '' = mọi project, '-' = lượt chưa ghi project, 'outside' = Claude Code ngoài app
  report: null,
  tab: 'router',        // tab của AI Hub: 'router' | 'stats'
  scroll: {},           // vị trí cuộn theo trang (hub:router / hub:stats / settings): view bị ẩn (display:none) thì mất scrollTop
  trial: { router: null, text: '', out: '' },   // ô "Try the judge" giữ nguyên qua các lần vẽ lại

  async show(view) {
    // Trang cũ hiện lại ngay ở chỗ đang đọc, trong lúc chờ trạng thái mới để vẽ lại.
    const old = $(`#view-${view} .hub-page`);
    if (old) old.scrollTop = this.scroll[this.scrollKey(view)] || 0;
    try { this.st = await window.menorah.hub(); } catch (e) { toast(errText(e)); return; }
    if (view === 'settings') this.renderSettings();
    else this.renderHub();
  },
  scrollKey(view) {
    if (view !== 'hub') return view;
    return this.tab === 'router' && this.routerOpen ? `hub:router:${this.routerOpen}` : `hub:${this.tab}`;
  },

  // Đổi tab AI Hub (Router / Statistics); tab Statistics tải lại báo cáo mỗi lần mở.
  openTab(tab) {
    this.tab = tab === 'stats' ? 'stats' : 'router';
    this.renderHub();
  },
  // Mở trang chi tiết một router (null = về danh sách).
  openRouter(id) {
    this.routerOpen = id;
    this.renderHub();
  },

  async save(fn) {
    try { this.st = await fn(); return true; } catch (e) { toast(errText(e)); return false; }
  },

  // Gắn trang vào view và trả lại vị trí cuộn đã nhớ. `fill` vẽ phần cần đo (biểu đồ) trước khi cuộn,
  // nếu không trang còn ngắn và scrollTop bị kẹp về gần đầu.
  mount(view, page, fill) {
    const key = this.scrollKey(view);
    page.addEventListener('scroll', () => { this.scroll[key] = page.scrollTop; });
    $(`#view-${view}`).replaceChildren(page);
    fill?.();
    page.scrollTop = this.scroll[key] || 0;
  },

  // Đổi tab tại chỗ: chỉ chuyển nút đang chọn, không vẽ lại trang.
  pickTab(btn) {
    for (const b of btn.parentElement.children) b.classList.toggle('on', b === btn);
  },

  // ─── Settings: nhà cung cấp ────────────────────────────────────────────
  // Danh sách thẻ cho nhà cung cấp đã thêm; "Add provider" mở hộp chọn loại. Mỗi loại thêm được một lần.
  renderSettings() {
    const added = this.st.providers.filter((p) => p.added);
    const canAdd = this.st.providers.some((p) => !p.added);
    const addBtn = h('button.primary', { disabled: !canAdd || !this.st.encryption, onclick: () => this.providerModal() }, icon('plus'), 'Add provider');
    const page = h('div.hub-page',
      h('header.hub-head', h('h1', 'Settings'), h('p.muted', 'Set up AI providers ahead of time so the Inference Router (AI Hub) can talk to their models.')),
      !this.st.encryption && h('div.hub-warn', 'The OS keychain is unavailable — API keys cannot be saved.'),
      h('section.pv-section',
        h('div.pv-head',
          h('div', h('h2', 'Providers'), h('p.muted', 'API keys are encrypted with the OS keychain and only used by the main process — this page can never read them back.')),
          addBtn),
        added.length
          ? h('div.pv-grid', added.map((p) => this.providerCard(p)))
          : h('div.pv-empty', h('div.pv-ico', icon('cloud')), h('b', 'No providers yet'),
            h('p.muted', 'Add OpenRouter, OpenAI, Gemini, DeepSeek, your own server, or TypeSafe as the router judge.'), canAdd && h('button', { onclick: () => this.providerModal() }, icon('plus'), 'Add provider')),
      ),
    );
    this.mount('settings', page);
  },

  providerName(p) { return p.name || p.label; },
  host(url) { return String(url || '').replace(/^https?:\/\//, ''); },

  // Chỗ đang dùng nhà cung cấp: model chấm của router, đích của task.
  providerUses(p) {
    const r = this.st.router, uses = [];
    if (r.judge.provider === p.id) uses.push('Inference Router judge');
    for (const [id, t] of Object.entries(r.tasks)) if (t.target?.provider === p.id) uses.push(this.taskName(id));
    return uses;
  },

  providerCard(p) {
    const status = p.lastError ? h('span.pv-pill.bad', { title: p.lastError }, h('i'), 'Error')
      : p.checkedAt ? h('span.pv-pill.ok', h('i'), 'Connected') : h('span.pv-pill', h('i'), 'Not checked');
    const uses = this.providerUses(p);
    const fact = (label, value) => h('div.pv-fact', h('span', label), value);
    const testBtn = h('button.pv-test', { onclick: async () => {
      testBtn.disabled = true; testBtn.lastChild.textContent = 'Checking…';
      try { const r = await window.menorah.hubProviderTest(p.id); this.st = r.state; toast(`${this.providerName(p)}: connected · ${r.count} models`); } catch (e) {
        toast(`${this.providerName(p)}: ${errText(e)}`);
        try { this.st = await window.menorah.hub(); } catch {}
      }
      this.renderSettings();
    } }, icon('restart'), h('span', 'Test connection'));
    const more = h('button.ghost.icon-btn.pv-more', { title: 'More', onclick: (e) => { e.stopPropagation(); this.providerMenu(p, more); } }, icon('more'));
    return h('article.pv-card',
      h('div.pv-top',
        h('div.pv-ico', icon(p.server ? 'server' : 'cloud')),
        h('div.pv-title',
          h('div.pv-name', this.providerName(p), p.judgeOnly && h('span.hub-badge', 'judge only')),
          h('div.pv-sub', p.name && p.name !== p.label ? `${p.label} · ` : '', h('span.mono', this.host(p.base)))),
        status, more),
      h('div.pv-facts',
        fact('API key', p.hasKey ? h('span.mono.pv-key', `••••  ••••${p.keyHint.replace('…', '')}`) : h('span.muted', 'None')),
        fact('Used by', uses.length ? h('span', uses.join(', ')) : h('span.muted', 'Not used yet')),
        fact('Last checked', p.lastError ? h('span.pv-err', { title: p.lastError }, `${timeAgo(p.checkedAt)} · failed`)
          : p.checkedAt ? h('span', `${timeAgo(p.checkedAt)}`, h('span.muted', ` · ${p.models.length} models`)) : h('span.muted', 'Never')),
        fact('Default model', p.model ? h('span.mono', p.model) : h('span.muted', 'Not set')),
      ),
      h('div.pv-foot',
        p.addedAt ? h('span.muted.pv-added', `Added ${timeAgo(p.addedAt)}`) : h('span'),
        h('button.ghost', { onclick: () => this.providerModal(p) }, icon('pencil'), 'Edit'),
        testBtn),
    );
  },

  // Menu ⋯ của thẻ: hiện nay chỉ có "Remove provider".
  providerMenu(p, anchor) {
    document.querySelector('.pv-menu')?.remove();
    const r = anchor.getBoundingClientRect();
    const menu = h('div.pv-menu', { style: `top:${r.bottom + 4}px;right:${window.innerWidth - r.right}px` },
      h('button', { onclick: () => { this.providerModal(p); } }, icon('pencil'), 'Edit'),
      h('button.danger', { onclick: async () => {
        const uses = this.providerUses(p);
        const name = this.providerName(p);
        if (!(await confirmBox(`Remove ${name}?`, `The saved key and settings are deleted.${uses.length ? ` Switched back to Claude: ${uses.join(', ')}.` : ''}`, 'Remove', true))) return;
        if (await this.save(() => window.menorah.hubProviderRemove(p.id))) { toast(`Removed ${name}`); this.renderSettings(); }
      } }, icon('close'), 'Remove provider'));
    const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off, true); } };
    menu.addEventListener('click', () => { menu.remove(); document.removeEventListener('mousedown', off, true); });
    document.addEventListener('mousedown', off, true);
    document.body.append(menu);
  },

  // Thêm (edit = null) hoặc sửa một nhà cung cấp. Main gọi thử <gốc>/models bằng khóa mới trước khi lưu.
  providerModal(edit = null) {
    const types = this.st.providers;
    let pick = edit || types.find((p) => !p.added);
    return modal((d, close) => {
      d.classList.add('pv-dialog');
      const typeGrid = !edit && h('div.pv-types', types.map((p) => h(`button.pv-type${p.added ? '.taken' : ''}`, {
        type: 'button', disabled: p.added, 'aria-pressed': String(p === pick), title: p.added ? 'Already added' : '',
        onclick: () => { pick = p; sync(); },
      }, h('div.pv-ico', icon(p.server ? 'server' : 'cloud')), h('div', h('b', p.label, p.added && h('span.hub-badge', 'Added')), h('span', p.blurb)))));
      const key = h('input', { type: 'password', autocomplete: 'off', spellcheck: false });
      const eye = h('button.ghost.icon-btn.pv-eye', { type: 'button', title: 'Show key', onclick: () => { key.type = key.type === 'password' ? 'text' : 'password'; } }, icon('eye'));
      const keyLabel = h('span');
      const keyLink = h('a', { target: '_blank', rel: 'noreferrer' });
      const keyHelp = h('div.help');
      const base = h('input.mono', { type: 'text', spellcheck: false });
      const baseRow = h('div', h('label', 'Base URL', h('span.req', ' *')), base, h('div.help', 'The OpenAI-style API root, e.g. http://localhost:11434/v1 — Git Menorah calls <base>/models and <base>/chat/completions.'));
      const model = h('input.mono', { type: 'text', spellcheck: false, list: 'pv-models' });
      const models = h('datalist#pv-models');
      const name = h('input', { type: 'text', maxlength: 60 });
      const nameHelp = h('div.help');
      const err = h('div.err');
      const ok = h('button.primary', { onclick: () => submit() });
      const sync = () => {
        typeGrid && typeGrid.querySelectorAll('.pv-type').forEach((b, i) => b.setAttribute('aria-pressed', String(types[i] === pick)));
        const p = pick;
        keyLabel.replaceChildren('API key', p.server ? h('span.opt', ' (optional)') : h('span.req', ' *'));
        keyLink.hidden = !p.keyUrl;
        if (p.keyUrl) { keyLink.href = p.keyUrl; keyLink.replaceChildren(`Get a key at ${p.label}`, icon('external')); }
        key.placeholder = edit?.hasKey ? `Saved ${edit.keyHint} — leave empty to keep` : p.server ? 'Only if the server asks for one' : '';
        keyHelp.textContent = 'Encrypted when saved and never shown again.';
        baseRow.hidden = !p.server;
        base.value = edit ? p.base : p.base || '';
        base.placeholder = p.id === 'ollama' ? 'http://localhost:11434/v1' : 'https://llm.example.com/v1';
        model.value = edit ? p.model : p.model || '';
        model.placeholder = p.model || 'Model id';
        models.replaceChildren(...(p.models || []).map((m) => h('option', { value: m })));
        name.value = edit ? p.name : '';
        name.placeholder = p.label;
        nameHelp.textContent = `Leave empty to use “${p.label}”.`;
        ok.textContent = edit ? 'Save' : 'Add provider';
        err.textContent = '';
      };
      const submit = async () => {
        ok.disabled = true; ok.textContent = 'Checking…'; err.textContent = '';
        try {
          const r = await window.menorah.hubProviderSave({ id: pick.id, key: key.value, base: base.value, model: model.value, name: name.value });
          this.st = r.state;
          close();
          toast(`${name.value.trim() || pick.label}: connected · ${r.count} models`);
          this.renderSettings();
        } catch (e) {
          err.textContent = errText(e);
          ok.disabled = false; ok.textContent = edit ? 'Save' : 'Add provider';
        }
      };
      d.append(
        h('div.pv-dhead',
          h('div', h('h3', edit ? `Edit ${this.providerName(edit)}` : 'Add AI provider'), h('p', 'Git Menorah calls the provider with this key before saving.')),
          h('button.ghost.icon-btn', { title: 'Close', onclick: () => close() }, icon('close'))),
        h('div.pv-dbody',
          typeGrid && h('label', 'Type'), typeGrid,
          baseRow,
          h('div.pv-keyhead', h('label', keyLabel), keyLink),
          h('div.pv-keybox', key, eye), keyHelp,
          h('label', 'Default model'), model, models,
          h('label', 'Display name', h('span.opt', ' (optional)')), name, nameHelp,
          err),
        h('div.actions', h('button', { onclick: () => close() }, 'Cancel'), ok),
      );
      for (const el of [key, base, model, name]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ok.disabled) submit(); });
      sync();
    });
  },

  // ─── AI Hub ────────────────────────────────────────────────────────────
  // Hai tab: Router (cấu hình) và Statistics (báo cáo Luồng đi). Phần đầu trang giống hệt nhau ở mọi
  // tab — đổi tab không làm thanh tab nhảy chỗ.
  renderHub() {
    const stats = this.tab === 'stats';
    const open = !stats && this.st.routers.find((x) => x.id === this.routerOpen);
    if (!open) this.routerOpen = null;
    const tabs = [['router', 'Routers'], ['stats', 'Statistics']];
    const page = h('div.hub-page',
      h('header.hub-head',
        h('h1', 'AI Hub'),
        h('p.muted', 'Inference Router for Claude Code: send each subagent task to the right model, and see where turns, tokens and cost go.'),
        h('nav.hub-pagetabs', { role: 'tablist' }, tabs.map(([k, l]) => h(k === this.tab ? 'button.on' : 'button',
          { role: 'tab', 'aria-selected': String(k === this.tab), onclick: () => { if (k !== this.tab) this.openTab(k); } }, l)))),
      ...(stats ? [this.flowCard()] : open ? this.routerDetail(open) : [this.routerCard(), this.safetyCard(), this.routersList(), this.whereCard()]),
    );
    this.mount('hub', page, () => { if (stats && this.report) this.drawFlow(); });
    if (stats) this.loadReport();
  },

  routerCard() {
    const r = this.st.router;
    const sw = h('input', { type: 'checkbox', checked: r.enabled, onchange: async () => {
      if (await this.save(() => window.menorah.hubRouterSave({ enabled: sw.checked }))) {
        toast(sw.checked ? 'Router on — Claude Code sessions opened (or reopened) in an assigned project now go through it' : 'Router off — every session calls the API directly');
        this.renderHub();
      } else sw.checked = !sw.checked;
    } });
    const px = this.st.proxy;
    const status = !r.enabled ? h('span.muted', 'Off') : px.running ? h('span.hub-ok', `Running · 127.0.0.1:${px.port}`) : h('span.hub-bad', `Proxy not running: ${px.error || 'not started'}`);

    const upstream = h('input.mono', { type: 'text', value: r.upstream, placeholder: this.st.upstream, spellcheck: false });
    upstream.addEventListener('change', () => this.save(() => window.menorah.hubRouterSave({ upstream: upstream.value })).then(() => this.renderHub()));

    const judges = [{ id: 'claude', label: 'Claude (Claude Code sign-in)', model: 'claude-haiku-4-5', ok: true },
      ...this.st.providers.filter((p) => p.ready || p.id === r.judge.provider).map((p) => ({ id: p.id, label: this.providerName(p), model: p.model, ok: p.ready }))];
    const jp = h('select', judges.map((j) => h('option', { value: j.id, selected: j.id === r.judge.provider, disabled: !j.ok }, j.ok ? j.label : `${j.label} — no key`)));
    const jm = h('input.mono', { type: 'text', value: r.judge.model, spellcheck: false, list: 'hub-judge-models' });
    const jmList = h('datalist#hub-judge-models', (r.judge.provider === 'claude' ? this.st.claudeModels : this.st.providers.find((p) => p.id === r.judge.provider)?.models || []).map((m) => h('option', { value: m })));
    const saveJudge = (provider, model) => this.save(() => window.menorah.hubRouterSave({ judge: { provider, model } })).then(() => this.renderHub());
    jp.addEventListener('change', () => saveJudge(jp.value, judges.find((j) => j.id === jp.value).model));
    jm.addEventListener('change', () => saveJudge(jp.value, jm.value));


    return h('section.hub-card',
      h('div.hub-card-head.row',
        h('div', h('h2', 'Inference Router', h('span.hub-badge.cc-only', 'Claude Code only')),
          h('p.muted', 'Supports Claude Code only — Codex, Gemini CLI, shells and other agents are never routed. Claude Code sessions of a project with a router call the API through a local proxy, which forwards every request untouched (keys and sign-in included) to the upstream URL. Projects without a router call the API directly.')),
        h('label.hub-switch', sw, h('span.hub-slider'), status),
      ),
      h('div.hub-grid',
        h('label', h('span', 'Upstream URL'), upstream, h('small.muted', 'Empty = the original ANTHROPIC_BASE_URL from ~/.claude/settings.json, the environment, or api.anthropic.com.')),
        h('label', h('span', 'Judge model'), h('div.hub-inline', jp, jm, jmList), h('small.muted', 'Reads a subagent\'s task and sorts it into one task of the project\'s router. The verdict sticks to the subagent: judged once.')),
      ),
    );
  },

  // Lượt kiểm tra an toàn (bộ phân loại quyền của auto mode, soi lệnh Bash): mặc định đi thẳng Claude, bật thì router chấm.
  safetyCard() {
    const on = this.st.router.safety;
    const sw = h('input', { type: 'checkbox', checked: on, onchange: async () => {
      if (await this.save(() => window.menorah.hubRouterSave({ safety: sw.checked }))) {
        toast(sw.checked ? 'The router now judges safety checks too' : 'Safety checks run on Claude again');
        this.renderHub();
      } else sw.checked = !sw.checked;
    } });
    return h('section.hub-card.safety-card',
      h('div.hub-card-head.safety-head', icon('shield'), h('div',
        h('h2', 'Safety checks'),
        h('p.muted', 'Before running a command on its own, Claude Code sends a separate turn asking whether that command is safe (the auto mode permission classifier, Bash command checks). By default these turns run on Claude and show as "Safety check" in Statistics.'))),
      h('div.safety-row',
        h('div', h('b', 'Let the router judge safety checks'),
          h('small.muted', on
            ? 'On: the router judges safety checks too, and they run on the model set for the task they are sorted into. Turns carrying Anthropic safeguards still run on Claude.'
            : 'Off: safety checks pass through unchanged on Claude. Turning this on costs one judge call per safety check.')),
        h('label.hub-switch', sw, h('span.hub-slider'))),
    );
  },

  // Danh sách router dạng thẻ; bấm một thẻ để mở trang chi tiết (model từng task, thử model chấm).
  routersList() {
    return h('section.rt-section',
      h('div.pv-head', h('div', h('h2', 'My routers'),
        h('p.muted', 'Routers Claude Code can use. Assign a router to a project, or to Claude Code outside Git Menorah, below. Open a router to pick the Claude model and target for each task.'))),
      h('div.rt-list', this.st.routers.map((x) => this.routerItem(x))),
      h('div.rt-note', icon('info'), h('div',
        h('b', 'Preset routers'),
        h('p', 'A preset router comes with a ready-made task list for one kind of work, so you never name or describe tasks yourself: Git Menorah writes the task list and the judge\'s instructions. Each task starts on a suggested Claude model; the judge model and the model of every task are yours to change.'))),
    );
  },

  // Ai đang dùng router: tên project + "Outside Git Menorah" khi settings.json dùng nó.
  routerUsers(id) {
    return this.projectsOf(id).map((p) => p.name).concat(this.st.router.global === id ? ['Outside Git Menorah'] : []);
  },
  usedByText(users) { return users.length === 1 ? users[0] : `${users.length} projects`; },

  // Trạng thái router: chưa ai dùng / đã gán nhưng router đang tắt / đang chạy.
  routerPill(users) {
    if (!users.length) return h('span.pv-pill', h('i'), 'Not used');
    if (!this.st.router.enabled) return h('span.pv-pill.wait', h('i'), 'Router off');
    return h('span.pv-pill.ok', h('i'), 'Active');
  },

  // Tóm tắt model theo từng task: "3 Opus · 4 Sonnet · 2 Haiku".
  modelMix(router) {
    const fam = new Map();
    for (const t of router.tasks) {
      const m = this.st.router.tasks[t.id]?.claude || '';
      const f = m.match(/opus|sonnet|haiku|fable/)?.[0];
      const k = f ? f[0].toUpperCase() + f.slice(1) : 'Claude Code default';
      fam.set(k, (fam.get(k) || 0) + 1);
    }
    return [...fam].map(([k, n]) => `${n} ${k}`).join(' · ');
  },

  routerItem(x) {
    const users = this.routerUsers(x.id);
    const targets = x.tasks.filter((t) => this.st.router.tasks[t.id]?.target).length;
    const go = () => this.openRouter(x.id);
    return h('div.rt-item', { role: 'button', tabindex: '0', 'aria-label': `Open ${x.name}`, onclick: go,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } } },
      h('div.pv-ico', icon('route')),
      h('div.rt-body',
        h('div.rt-name', x.name, h('span.rt-tag', 'Preset'), this.routerPill(users)),
        h('div.rt-desc', x.desc),
        h('div.rt-meta',
          h('span', 'Judge ', h('code', this.st.router.judge.model)),
          h('span', `${x.tasks.length} tasks · ${this.modelMix(x)}`),
          h('span', targets ? `${targets} target${targets > 1 ? 's' : ''} saved` : 'All tasks stay on Claude'),
          h('span', users.length ? { title: users.join('\n') } : {}, users.length ? `Used by ${this.usedByText(users)}` : 'No project uses this router'))),
      h('span.rt-chev', icon('chev')));
  },

  // Nơi router được dùng: gán theo project + Claude Code ngoài app (settings.json).
  whereCard() {
    return h('section.hub-card',
      h('div.hub-card-head', h('h2', 'Where routers apply'),
        h('p.muted', 'Running sessions follow a new assignment from their next turn; sessions opened before the first assignment must be reopened.')),
      this.projectMap(),
      this.claudeConfigBox(),
      this.hookBox(),
    );
  },

  // Trang chi tiết một router: thông tin, thử model chấm, bảng task.
  routerDetail(x) {
    const users = this.routerUsers(x.id);
    const trial = this.trial;
    if (trial.router !== x.id) Object.assign(trial, { router: x.id, out: '' });
    const tryBox = h('input', { type: 'text', value: trial.text, placeholder: 'Sample task, e.g. "Write unit tests for parser.js"', oninput: () => { trial.text = tryBox.value; } });
    const tryOut = h('span.muted', trial.out);
    const say = (s) => { trial.out = s; if (tryOut.isConnected) tryOut.textContent = s; };
    const tryBtn = h('button', { onclick: async () => {
      tryBtn.disabled = true; say('Judging…');
      try {
        const v = await window.menorah.hubJudgeTest(tryBox.value, x.id);
        say(v.task ? `→ ${this.taskName(v.task)}` : v.outcome === 'no_match' ? '→ No task picked' : `→ error (${v.outcome})`);
      } catch (e) { say(errText(e)); }
      tryBtn.disabled = false;
    } }, 'Try');
    return [
      h('nav.rt-crumb', h('button.ghost', { onclick: () => this.openRouter(null) }, h('span.rt-back', icon('chev')), 'My routers'), h('span.muted', '/'), h('span', x.name)),
      h('section.hub-card.rt-detail',
        h('div.rt-dhead',
          h('div.pv-ico', icon('route')),
          h('div.rt-body',
            h('div.rt-name.big', x.name, h('span.rt-tag', 'Preset'), this.routerPill(users)),
            h('div.rt-desc', x.desc),
            h('div.rt-meta',
              h('span', 'Judge ', h('code', this.st.router.judge.model)),
              h('span', `${x.tasks.length} tasks · ${this.modelMix(x)}`),
              h('span', users.length ? `Used by ${users.join(', ')}` : 'No project uses this router yet — assign it under Where routers apply')))),
        h('div.hub-grid',
          h('label.wide', h('span', 'Try the judge'), h('div.hub-inline', tryBox, tryBtn), tryOut,
            h('small.muted', 'Sends the sample to the judge model with this router\'s task list and shows the task it picks.'))),
      ),
      this.tasksCard(x),
    ];
  },

  // Bảng gán router cho project. Router tắt thì bảng mờ đi nhưng vẫn sửa được (lưu sẵn để bật sau).
  projectMap() {
    const map = this.st.router.projects || {};
    const rows = this.st.projects.map((p) => {
      const sel = h('select', h('option', { value: '' }, 'No router'),
        this.st.routers.map((x) => h('option', { value: x.id, selected: map[p.id] === x.id }, x.name)));
      sel.addEventListener('change', async () => {
        if (await this.save(() => window.menorah.hubRouterSave({ projects: { [p.id]: sel.value || null } }))) {
          const x = this.st.routers.find((y) => y.id === sel.value);
          toast(x ? `${p.name} → ${x.name}. Claude Code sessions opened (or reopened) in this project go through the router.` : `${p.name} no longer uses a router — it calls the API directly.`);
          this.renderHub();
        } else sel.value = map[p.id] || '';
      });
      return h(map[p.id] ? 'div.proj-row.on' : 'div.proj-row',
        h('div.proj-info', h('div.proj-name', p.name), h('div.mono.muted', p.cwd)), sel);
    });
    return h(this.st.router.enabled ? 'div.proj-map' : 'div.proj-map.off',
      h('div.proj-map-head', h('span', 'Router per project'),
        h('small.muted', this.st.router.enabled ? 'Each project picks the router its Claude Code sessions use.' : 'The router is off — assign now, turn it on to apply.')),
      rows.length ? rows : h('div.muted.proj-empty', 'No projects yet. Add one from the Canvas tab.'));
  },

  // ~/.claude/settings.json → proxy của Git Menorah, cho Claude Code chạy ngoài app (terminal riêng, IDE).
  // Main sao lưu tệp gốc trước khi sửa; Restore trả lại đúng tệp đó.
  claudeConfigBox() {
    const c = this.st.claudeConfig;
    const r = this.st.router;
    const routerSel = h('select', h('option', { value: '' }, 'No router (pass through, not logged)'),
      this.st.routers.map((x) => h('option', { value: x.id, selected: r.global === x.id }, x.name)));
    routerSel.addEventListener('change', async () => {
      if (await this.save(() => window.menorah.hubRouterSave({ global: routerSel.value || null }))) this.renderHub();
      else routerSel.value = r.global || '';
    });
    const install = h('button.primary', { onclick: async () => {
      const ok = await confirmBox(c.installed ? 'Reinstall into settings.json?' : 'Point Claude Code at Git Menorah?',
        `This sets env.ANTHROPIC_BASE_URL in ${c.file} to Git Menorah's local proxy. The current file is backed up first and Restore puts it back. While installed, Claude Code only works while Git Menorah is running.`,
        c.installed ? 'Reinstall' : 'Install');
      if (!ok) return;
      try { this.st = await window.menorah.hubClaudeInstall(); toast('settings.json now points at Git Menorah — start (or restart) Claude Code to use it'); this.renderHub(); } catch (e) { toast(errText(e)); }
    } }, c.installed ? 'Reinstall' : 'Install into settings.json');
    const restore = c.installed && h('button', { onclick: async () => {
      if (!(await confirmBox('Restore the original settings.json?', `Claude Code outside Git Menorah will call ${c.original || 'api.anthropic.com'} directly again. Running Claude Code sessions keep the proxy until restarted.`, 'Restore'))) return;
      try {
        const x = await window.menorah.hubClaudeRestore();
        this.st = x.state;
        toast(x.mode === 'exact' ? 'Original settings.json restored' : 'ANTHROPIC_BASE_URL restored — other changes made to settings.json since install were kept');
        this.renderHub();
      } catch (e) { toast(errText(e)); }
    } }, 'Restore original');
    const current = c.current ? h('code', c.current.replace(/\/t\/[0-9a-f]+/, '/t/…')) : h('span', 'not set (api.anthropic.com)');
    return h(c.installed ? 'div.cc-box.on' : 'div.cc-box',
      h('div.proj-map-head', h('span', 'Claude Code outside Git Menorah'),
        c.installed ? h('span.hub-badge.on', `Installed ${timeAgo(c.at)}`) : h('span.hub-badge', 'Not installed')),
      h('div.cc-body',
        h('p.muted', 'Install points ~/.claude/settings.json at Git Menorah\'s proxy, so Claude Code started anywhere — your own terminal, an IDE — goes through the router too. Canvas sessions keep their per-project router.'),
        c.error && h('div.hub-warn', c.error),
        c.installed && !c.ours && h('div.hub-warn', 'settings.json was changed after install: ANTHROPIC_BASE_URL no longer points at Git Menorah. Reinstall, or Restore to go back to the original.'),
        !c.installed && c.foreign && h('div.hub-warn', 'settings.json already points at a local Git Menorah proxy that this install does not own (backup lost?). Install again to take it over, then Restore to your original URL by hand if needed.'),
        c.installed && h('div.hub-warn', 'While installed, Claude Code depends on Git Menorah: if the app is closed, Claude Code cannot reach the API. Restore before quitting for good or uninstalling Git Menorah.'),
        h('div.cc-facts',
          h('span', 'File'), h('code', c.file),
          h('span', 'ANTHROPIC_BASE_URL'), current,
          c.installed && h('span', 'Original'), c.installed && (c.original ? h('code', c.original) : h('span', 'not set (api.anthropic.com)')),
          c.installed && h('span', 'Backup'), c.installed && h('code', c.backup),
        ),
        h('div.cc-actions', h('label', h('span', 'Router'), routerSel), h('div.grow'), restore, install),
        !r.enabled && c.installed && h('small.muted', 'The router is off — turns pass straight through until you turn it on.'),
      ));
  },

  // Hook SubagentStart (Explore, general-purpose) trong ~/.claude/settings.json: báo subagent mới về AI Hub.
  // Chỉ thêm / bỏ hook của Git Menorah; hook khác trong SubagentStart giữ nguyên.
  hookBox() {
    const c = this.st.hookConfig;
    const install = h('button.primary', { onclick: async () => {
      const ok = await confirmBox(c.installed ? 'Reinstall the SubagentStart hook?' : 'Catch subagents with a SubagentStart hook?',
        `This adds a SubagentStart hook for ${c.wanted.join(' and ')} to ${c.file}. It runs a small script that tells Git Menorah a subagent started; when Git Menorah is closed it does nothing. Other hooks are left alone, and Remove takes only this one out.`,
        c.installed ? 'Reinstall' : 'Install');
      if (!ok) return;
      try { this.st = await window.menorah.hubHookInstall(); toast('SubagentStart hook installed — new Claude Code sessions pick it up'); this.renderHub(); } catch (e) { toast(errText(e)); }
    } }, c.installed ? 'Reinstall' : 'Install hook');
    const remove = (c.installed || c.matchers.length > 0) && h('button', { onclick: async () => {
      if (!(await confirmBox('Remove the SubagentStart hook?', `Takes Git Menorah's hook out of ${c.file}. Other hooks stay.`, 'Remove'))) return;
      try { this.st = await window.menorah.hubHookRemove(); toast('SubagentStart hook removed'); this.renderHub(); } catch (e) { toast(errText(e)); }
    } }, 'Remove');
    return h(c.installed ? 'div.cc-box.on' : 'div.cc-box',
      h('div.proj-map-head', h('span', 'Catch subagents (SubagentStart)'),
        c.installed ? h('span.hub-badge.on', `Installed ${timeAgo(c.at)}`) : h('span.hub-badge', 'Not installed')),
      h('div.cc-body',
        h('p.muted', 'Claude Code runs this hook when it starts an Explore or general-purpose subagent, in the app or outside it. Git Menorah records the subagent in Flow, uses it to tell the router the agent type when a turn lacks that header, and gives general-purpose subagents of a project with a router one line on staying on their task.'),
        c.error && h('div.hub-warn', c.error),
        c.installed && c.missing.length > 0 && h('div.hub-warn', `settings.json no longer has the hook for ${c.missing.join(', ')}. Reinstall to add it back.`),
        !c.installed && c.matchers.length > 0 && h('div.hub-warn', 'settings.json has a Git Menorah SubagentStart hook this install does not own. Remove it, or Install to take it over.'),
        h('div.cc-facts',
          h('span', 'File'), h('code', c.file),
          h('span', 'Subagents'), h('span', c.wanted.join(', ')),
          h('span', 'Script'), h('code', c.script),
          c.others > 0 && h('span', 'Other hooks'), c.others > 0 && h('span', `${c.others} other SubagentStart hook${c.others > 1 ? 's' : ''} in this file — left as they are`),
        ),
        h('div.cc-actions', h('div.grow'), remove, install),
      ));
  },

  // Project đang dùng một router (theo bảng gán).
  projectsOf(routerId) { return this.st.projects.filter((p) => this.st.router.projects?.[p.id] === routerId); },
  projectName(id) {
    if (id === '-' || id == null) return 'No project recorded';
    if (id === OUTSIDE) return 'Outside Git Menorah';
    return this.st.projects.find((p) => p.id === id)?.name || 'Deleted project';
  },
  taskName(id) { return this.st.routers.flatMap((x) => x.tasks).find((t) => t.id === id)?.name || HUB_TASK_LABEL[id] || id; },
  providerLabel(id) { return this.st.providers.find((p) => p.id === id)?.label || id; },

  tasksCard(router) {
    const conf = this.st.router.tasks;
    const rows = router.tasks.map((t) => {
      const c = conf[t.id] || {};
      const dest = c.target
        ? h('div.dest', h('span.dest-who', this.providerLabel(c.target.provider)), h('span.mono', c.target.model),
          h('span.hub-badge.wait', { title: 'No Anthropic ↔ OpenAI protocol translation yet: turns still run on Claude' }, 'saved · runs on Claude'),
          h('button.ghost.icon-btn', { title: 'Remove target', onclick: () => this.setTask(t.id, { target: null }) }, icon('close')))
        : h('div.dest', h('span.dest-who', 'Keep on Claude'), h('span.mono.muted', c.claude || 'model Claude Code picks'));
      return h('div.task-row',
        h('div.task-info',
          h('div.task-name', t.name, h('span.hub-badge', t.risky && h('i.dot'), t.access)),
          h('div.muted', t.desc),
        ),
        dest,
        h('div.task-act',
          h('button', { onclick: () => this.assignTarget(t) }, icon('plus'), c.target ? 'Change target' : 'Set target'),
          h('button.ghost.icon-btn', { title: 'Claude model for this task', onclick: () => this.pickClaude(t) }, h('span', { html: '<svg class="i" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>' })),
        ),
      );
    });
    return h('section.hub-card',
      h('div.hub-card-head',
        h('h2', `Tasks · ${router.tasks.length}`),
        h('p.muted', 'The judge model sorts each subagent into one task. The default target is Keep on Claude: only set a target for tasks you have seen judged correctly.')),
      h('div.task-table', h('div.task-row.task-th', h('div', 'Task'), h('div', 'Target'), h('div')), rows),
      h('p.hub-foot', 'ⓘ If the target model fails, or the subagent conversation is too long, the turn runs on Claude. Targets at other providers are only saved for now — turns keep running on Claude until protocol translation lands.'),
    );
  },

  async setTask(id, patch) {
    if (await this.save(() => window.menorah.hubRouterSave({ tasks: { [id]: patch } }))) this.renderHub();
  },

  pickClaude(t) {
    const cur = this.st.router.tasks[t.id]?.claude || '';
    return modal((d, close) => {
      const sel = h('select', h('option', { value: '' }, 'Keep the model Claude Code picks'),
        [...new Set([...this.st.claudeModels, cur].filter(Boolean))].map((m) => h('option', { value: m, selected: m === cur }, m)));
      d.append(h('h3', `Claude model · ${t.name}`),
        h('p', 'Turns of subagents judged into this task are sent with this model. If Anthropic rejects it, the turn is resent with the model Claude Code picked.'),
        h('label', 'Model'), sel,
        h('div.actions', h('button', { onclick: () => close() }, 'Cancel'), h('button.primary', { onclick: () => { close(); this.setTask(t.id, { claude: sel.value || null }); } }, 'Save')));
    });
  },

  assignTarget(t) {
    const provs = this.st.providers.filter((p) => !p.judgeOnly && p.ready);
    const cur = this.st.router.tasks[t.id]?.target;
    if (!provs.length) return confirmBox('No provider yet', 'Add a provider (OpenRouter, OpenAI, Gemini, DeepSeek or your own server) in Settings first.', 'OK');
    return modal((d, close) => {
      const sel = h('select', provs.map((p) => h('option', { value: p.id, selected: cur?.provider === p.id }, this.providerName(p))));
      const model = h('input.mono', { type: 'text', list: 'hub-target-models', spellcheck: false });
      const list = h('datalist#hub-target-models');
      const sync = (keep) => {
        const p = provs.find((x) => x.id === sel.value);
        if (!keep) model.value = p.model;
        list.replaceChildren(...p.models.map((m) => h('option', { value: m })));
      };
      model.value = cur?.model || '';
      sel.addEventListener('change', () => sync(false));
      sync(!!cur);
      d.append(h('h3', `Set target · ${t.name}`),
        h('p', 'Save the provider and target model for this task. This version does not translate the Anthropic ↔ OpenAI protocol yet, so turns still run on Claude; the Flow chart in Statistics shows how tasks are judged so you can decide.'),
        h('label', 'Provider'), sel, h('label', 'Model'), model, list,
        h('div.actions', h('button', { onclick: () => close() }, 'Cancel'),
          h('button.primary', { onclick: () => { if (!model.value.trim()) return; close(); this.setTask(t.id, { target: { provider: sel.value, model: model.value.trim() } }); } }, 'Set')));
    });
  },

  // ─── Luồng đi (Sankey) ─────────────────────────────────────────────────
  flowCard() {
    const tabs = [['n', 'Turns'], ['tokens', 'Tokens'], ['cost', 'Cost']];
    const periods = [[1, 'Today'], [7, '7 days'], [30, '30 days'], [0, 'All']];
    return h('section.hub-card',
      h('div.hub-card-head.row',
        h('div', h('h2', 'Flow'),
          h('p.muted', 'Every Claude Code turn flows through a router (or the task table), into a task, then to the model that answered. Thicker bands mean more. Judge turns get one extra column: the task the judge picked. The router is recorded with each turn, so reassigning a project does not change past numbers.')),
        h('div.hub-tabs', tabs.map(([k, l]) => h('button', { class: k === this.metric ? 'on' : null, onclick: (e) => { this.metric = k; this.pickTab(e.currentTarget); this.drawFlow(); } }, l))),
      ),
      h('div.flow-bar',
        h('div.hub-tabs.small', periods.map(([d, l]) => h('button', { class: d === this.days ? 'on' : null, onclick: (e) => { this.days = d; this.pickTab(e.currentTarget); this.loadReport(); } }, l))),
        h('select#flow-project', { title: 'Filter by project', onchange: (e) => { this.project = e.target.value; this.loadReport(); } }),
        h('div#flow-total.muted'),
        h('span.grow'),
        h('button.ghost', { onclick: () => this.loadReport() }, icon('restart'), 'Reload'),
        h('button.ghost', { onclick: async () => {
          if (!(await confirmBox('Delete usage data?', 'Deletes every turn recorded in usage.db on this machine.', 'Delete', true))) return;
          await window.menorah.hubReportClear(); this.loadReport();
        } }, 'Delete data'),
      ),
      h('div#flow-chart.flow-chart'),
      h('div.flow-legend',
        h('span', h('i.sw.claude'), 'Answered by Claude'), h('span', h('i.sw.prov'), 'Answered by another provider'), h('span', h('i.sw.none'), NOT_RECORDED)),
    );
  },

  async loadReport() {
    try { this.report = await window.menorah.hubReport(this.days, this.project); } catch (e) { this.report = { error: errText(e) }; }
    this.drawFlow();
  },

  // Bộ lọc project: mọi project của workspace, cộng project đã xóa / lượt cũ chưa ghi project nếu có số liệu.
  fillProjectFilter() {
    const sel = $('#flow-project');
    if (!sel) return;
    const counts = new Map((this.report.projects || []).map((x) => [x.project ?? '-', x.n]));
    const ids = [...new Set([...this.st.projects.map((p) => p.id), ...counts.keys(), ...(this.project ? [this.project] : [])])];
    const all = [...counts.values()].reduce((a, b) => a + b, 0);
    sel.replaceChildren(h('option', { value: '' }, `All projects · ${fmtInt(all)}`),
      ...ids.map((id) => h('option', { value: id, selected: id === this.project }, `${this.projectName(id)} · ${fmtInt(counts.get(id) || 0)}`)));
  },

  // Mỗi lượt là một đường qua các cột; cùng cặp nút kề nhau + cùng loại trả lời thì gộp thành một dòng.
  flowPaths() {
    const out = [];
    for (const f of this.report.flows || []) {
      const v = this.metric === 'n' ? f.n : this.metric === 'tokens' ? f.tokens || 0 : f.cost || 0;
      if (!(v > 0)) continue;
      const kind = !f.router ? 'none' : f.provider === 'anthropic' ? 'claude' : 'prov';
      const nodes = ['Claude Code', HUB_ROUTER_LABEL[f.router] || NOT_RECORDED,
        f.router ? this.taskName(f.task) : NOT_RECORDED, f.model || 'unknown model'];
      if (f.task === 'judge') nodes.push(f.judged ? this.taskName(f.judged) : 'No task picked');
      out.push({ nodes, kind, v });
    }
    return out;
  },

  drawFlow() {
    const host = $('#flow-chart');
    if (!host || !this.report) return;
    host.innerHTML = '';
    this.fillProjectFilter();
    const tot = $('#flow-total');
    if (this.report.error) { host.append(h('div.flow-empty', this.report.error)); return; }
    const t = this.report.total || {};
    const subs = (this.report.subagents || []).map((x) => `${x.agent_type || 'unknown'} ${fmtInt(x.n)}`).join(', ');
    if (tot) tot.textContent = `${fmtInt(t.n)} turns · ${fmtTok((t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0))} tokens · ${fmtUsd(t.cost)} estimated${subs ? ` · subagents caught: ${subs}` : ''}`;
    const paths = this.flowPaths();
    if (!paths.length) {
      host.append(h('div.flow-empty', this.st.router.enabled ? 'No turns in this period. Open (or reopen) a Claude Code session on the canvas of a project with a router to start recording.' : 'No data yet. Turn on the Inference Router and assign a router to a project in AI Hub, then open a Claude Code session on that project\'s canvas.'));
      return;
    }
    const fmt = this.metric === 'n' ? fmtInt : this.metric === 'tokens' ? fmtTok : fmtUsd;

    // Nút theo cột, giá trị nút = tổng dòng đi qua.
    const cols = [[], [], [], [], []];
    const nodeMap = new Map();
    const links = new Map();
    for (const p of paths) {
      p.nodes.forEach((name, c) => {
        const id = `${c}\u0000${name}`;
        let n = nodeMap.get(id);
        if (!n) { n = { id, name, c, v: 0, kinds: {}, out: [], in: [] }; nodeMap.set(id, n); cols[c].push(n); }
        n.v += p.v;
        n.kinds[p.kind] = (n.kinds[p.kind] || 0) + p.v;
        if (c > 0) {
          const lid = `${p.nodes[c - 1]}\u0000${c}\u0000${name}\u0000${p.kind}`;
          let l = links.get(lid);
          if (!l) { l = { s: nodeMap.get(`${c - 1}\u0000${p.nodes[c - 1]}`), t: n, kind: p.kind, v: 0 }; links.set(lid, l); l.s.out.push(l); n.in.push(l); }
          l.v += p.v;
        }
      });
    }
    const used = cols.filter((c) => c.length);
    const total = used[0].reduce((a, n) => a + n.v, 0);
    for (const c of used) c.sort((a, b) => b.v - a.v);

    // Độ dày theo giá trị; mỗi nút chừa ít nhất một ô cho hai dòng nhãn. Cột sau đặt nút gần trọng
    // tâm các dòng vào rồi đẩy xuống cho khỏi chồng — ít bắt chéo, cột nhỏ (lượt chấm) nằm cạnh nguồn.
    const W = Math.max(720, host.clientWidth || 900);
    const pad = 8, nodeW = 10, labelW = 160, top = 26, slot = 30;
    const k = 380 / total;
    const colX = (i) => 4 + i * ((W - labelW - nodeW - 8) / Math.max(1, used.length - 1));
    let bottom = 0;
    used.forEach((c, i) => {
      for (const n of c) {
        n.h = Math.max(2, n.v * k);
        const w = n.in.reduce((a, l) => a + l.v, 0);
        n.ideal = i === 0 ? 0 : n.in.reduce((a, l) => a + l.v * (l.s.y + l.s.h / 2), 0) / w - n.h / 2;
      }
      if (i > 0) c.sort((a, b) => a.ideal - b.ideal || b.v - a.v);
      let y = top;
      for (const n of c) { n.x = colX(i); n.y = Math.max(y, i === 0 ? top : n.ideal); y = n.y + Math.max(n.h, slot) + pad; }
      bottom = Math.max(bottom, y);
    });
    const H = bottom - top;
    // Dòng xếp theo vị trí nút ở đầu kia để ít bắt chéo.
    for (const n of nodeMap.values()) {
      n.out.sort((a, b) => a.t.y - b.t.y || (a.kind < b.kind ? -1 : 1));
      n.in.sort((a, b) => a.s.y - b.s.y || (a.kind < b.kind ? -1 : 1));
      let o = n.y; for (const l of n.out) { l.sy = o + (l.v * k) / 2; o += l.v * k; }
      let q = n.y; for (const l of n.in) { l.ty = q + (l.v * k) / 2; q += l.v * k; }
    }

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'flow-svg');
    svg.setAttribute('width', W); svg.setAttribute('height', H + top + 10);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Flow: ${fmt(total)} from Claude Code`);
    const el = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [a, b] of Object.entries(attrs)) e.setAttribute(a, b); if (text != null) e.textContent = text; return e; };
    const tip = $('#flow-tip') || document.body.appendChild(h('div#flow-tip.flow-tip', { hidden: true }));
    const showTip = (ev, text) => { tip.textContent = text; tip.hidden = false; tip.style.left = `${ev.clientX + 12}px`; tip.style.top = `${ev.clientY + 12}px`; };
    const hideTip = () => { tip.hidden = true; };

    ['Source', 'Router', 'Task', 'Answering model', 'Task the judge picked'].slice(0, used.length).forEach((t, i) => {
      svg.append(el('text', { x: colX(i), y: 12, class: 'flow-col' }, t));
    });
    const gl = el('g', {});
    for (const l of links.values()) {
      const x0 = l.s.x + nodeW, x1 = l.t.x, mx = (x0 + x1) / 2;
      const p = el('path', { d: `M${x0},${l.sy} C${mx},${l.sy} ${mx},${l.ty} ${x1},${l.ty}`, class: `flow-link ${l.kind}`, 'stroke-width': Math.max(1, l.v * k) });
      p.addEventListener('mousemove', (ev) => showTip(ev, `${l.s.name} → ${l.t.name}: ${fmt(l.v)} · ${fmtPct(l.v / total)}`));
      p.addEventListener('mouseleave', hideTip);
      gl.append(p);
    }
    svg.append(gl);
    for (const n of nodeMap.values()) {
      const main = Object.entries(n.kinds).sort((a, b) => b[1] - a[1])[0][0];
      const r = el('rect', { x: n.x, y: n.y, width: nodeW, height: n.h, rx: 2, class: `flow-node ${n.c === 0 ? 'src' : main}` });
      r.addEventListener('mousemove', (ev) => showTip(ev, `${n.name}: ${fmt(n.v)} · ${fmtPct(n.v / total)}`));
      r.addEventListener('mouseleave', hideTip);
      svg.append(r);
      const tx = n.x + nodeW + 6, cy = n.y + n.h / 2;
      const label = el('text', { x: tx, y: cy - 2, class: 'flow-lbl' }, n.name.length > 26 ? `${n.name.slice(0, 24)}…` : n.name);
      const sub = el('text', { x: tx, y: cy + 11, class: 'flow-sub' }, `${fmt(n.v)} · ${fmtPct(n.v / total)}`);
      svg.append(label, sub);
    }
    host.append(svg);
  },
};

window.addEventListener('resize', debounce(() => { if (!$('#view-hub')?.hidden && AIHub.tab === 'stats') AIHub.drawFlow(); }, 150));
