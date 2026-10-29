// Plugins (rail › Plugins): phần thêm, mỗi cái bật / tắt riêng và có tuỳ chọn của nó ngay trên thẻ.
// Bật là có hiệu lực ngay trong cả app — terminal, ô nhập, note và trang Git.
'use strict';

const Plugins = {
  bound: false,

  show() {
    // Nghe một lần: đổi cài đặt (ở đây, bằng ⌃⇧ hay chip VI / EN) thì vẽ lại khi trang đang mở.
    if (!this.bound) { this.bound = true; vnInput.listen(() => { if (!$('#view-plugins').hidden) this.show(); }); }
    vnInput.probe();
    const page = h('div.hub-page',
      h('header.hub-head', h('h1', 'Plugins'), h('p.muted', 'Optional add-ons. Turn one on and it works everywhere in Git Menorah.')),
      this.vnCard(),
    );
    const old = $('#view-plugins .hub-page');
    $('#view-plugins').replaceChildren(page);
    if (old) page.scrollTop = old.scrollTop;
  },

  // Gõ tiếng Việt (app/vnkey.js): Telex / VNI cho terminal, prompt của agent, note, chat và mọi ô nhập.
  vnCard() {
    const c = vnInput.cfg, keys = app.info.platform === 'darwin' ? '⌃⇧ (Control + Shift)' : 'Ctrl + Shift';
    const sw = h('input', { type: 'checkbox', checked: c.enabled, onchange: () => {
      vnInput.set({ enabled: sw.checked, on: true });
      toast(sw.checked ? `Vietnamese typing on — press ${keys} to switch between VI and EN` : 'Vietnamese typing off');
    } });
    const other = vnInput.system || 'Another Vietnamese keyboard', mine = c.method === 'vni' ? 'VNI' : 'Telex', now = c.on ? 'VI' : 'EN';
    const status = !c.enabled ? `Off — ${vnInput.system || 'your keyboard app'} types as usual everywhere.`
      : vnInput.mac && (vnInput.system || vnInput.foreign)
        ? `${other} is running. Terminals and the agent Chat box use the built-in ${mine} (${now} now) and block ${other} while one is focused; ${c.auto ? `text boxes leave typing to ${other}.` : `text boxes use the built-in too — switch ${other} to English so tone marks are not added twice.`}`
      : vnInput.system ? `${vnInput.system} is running on this computer${c.auto ? ' — the built-in typing stays off while it runs.' : '. Turn it off (or switch it to English) so the two do not add tone marks twice.'}`
      : vnInput.yielded() ? `Another Vietnamese keyboard is typing — the built-in typing paused. Press ${keys} to take over again.`
      : `No Vietnamese keyboard app found — Git Menorah types ${mine} itself (${now} now).`;
    const method = h('select', { onchange: () => vnInput.set({ method: method.value, on: true }) },
      [['telex', 'Telex — aa â · dd đ · s f r x j tones'], ['vni', 'VNI — 6 ^ · 7 ơ ư · 8 ă · 9 đ · 1–5 tones']]
        .map(([v, label]) => h('option', { value: v, selected: c.method === v }, label)));
    const check = (key, label) => h('label.check', h('input', { type: 'checkbox', checked: c[key], onchange: (e) => vnInput.set({ [key]: e.target.checked }) }), h('span', label));
    return h('section.hub-card.plugin-card',
      h('div.plugin-row',
        h('div.plugin-ico', icon('keyboard')),
        h('div.plugin-main',
          h('h2', 'Vietnamese typing'),
          h('p.muted', `Type Vietnamese with Telex or VNI without a keyboard app — in terminals, agent prompts, chat, notes and every text box, the Git tab included. Press ${keys}, or click VI / EN on a terminal's title bar, to switch between Vietnamese and English. Words that are not Vietnamese (push, sort, class…) stay as typed.`)),
        h('label.hub-switch', { title: c.enabled ? 'Turn off' : 'Turn on' }, sw, h('span.hub-slider'))),
      c.enabled && h('div.plugin-opts',
        h('label.field', h('span', 'Typing method'), method),
        check('auto', vnInput.mac
          ? 'In text boxes, leave typing to this computer\'s Vietnamese keyboard (GoTiengViet, OpenKey, EVKey, XKey…) when one runs. Terminals and the agent Chat box always use the built-in typing.'
          : 'Turn off when this computer already has a Vietnamese keyboard (UniKey, OpenKey, EVKey, GoTiengViet, XKey…)'),
        check('modern', 'Place tone marks the new way: hoà, thuỷ (instead of hòa, thủy)')),
      h('div.plugin-status', status),
    );
  },
};
