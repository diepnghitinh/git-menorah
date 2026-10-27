// Bộ gõ tiếng Việt cho xterm (Telex, VNI) — dùng chung cho node terminal trên canvas và khay
// Terminal của tab Git (trang Git nạp tệp này qua /vendor/vnkey/vnkey.js).
//
// Cách làm giống Unikey / OpenKey: giữ chữ của từ đang gõ, mỗi phím dựng lại cả từ rồi gửi vào
// PTY số backspace (\x7f) đủ xoá phần khác + phần chữ mới. Chữ luôn ở dạng dựng sẵn (NFC) nên
// một backspace xoá đúng một chữ trong shell lẫn ô nhập của Claude Code / Codex.
// Từ dựng ra không đúng chính tả tiếng Việt (class, push, sort…) thì trả về nguyên các phím đã
// gõ — lệnh tiếng Anh ít bị biến dạng.
(function (root) {
  'use strict';

  // Chữ có dấu: [nguyên âm][thanh] với thanh 0 ngang · 1 sắc · 2 huyền · 3 hỏi · 4 ngã · 5 nặng.
  const TONED = {
    a: 'aáàảãạ', 'ă': 'ăắằẳẵặ', 'â': 'âấầẩẫậ', e: 'eéèẻẽẹ', 'ê': 'êếềểễệ', i: 'iíìỉĩị',
    o: 'oóòỏõọ', 'ô': 'ôốồổỗộ', 'ơ': 'ơớờởỡợ', u: 'uúùủũụ', 'ư': 'ưứừửữự', y: 'yýỳỷỹỵ',
  };
  // Mũ (^), trăng (˘), móc (+) của từng chữ gốc.
  const MARKED = { a: { hat: 'â', breve: 'ă' }, e: { hat: 'ê' }, o: { hat: 'ô', horn: 'ơ' }, u: { horn: 'ư' } };
  // Chữ hiện trên màn hình → { b: chữ gốc, m: dấu mũ/trăng/móc, t: thanh }.
  const PARSE = {};
  for (const [v, row] of Object.entries(TONED)) {
    const b = { 'ă': 'a', 'â': 'a', 'ê': 'e', 'ô': 'o', 'ơ': 'o', 'ư': 'u' }[v] || v;
    const m = { 'ă': 'breve', 'â': 'hat', 'ê': 'hat', 'ô': 'hat', 'ơ': 'horn', 'ư': 'horn' }[v] || '';
    [...row].forEach((ch, t) => { PARSE[ch] = { b, m, t }; });
  }
  PARSE['đ'] = { b: 'd', m: 'stroke', t: 0 };
  const VN_CHAR = /[ăâêôơưđáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/iu;

  const VOWEL = new Set('aeiouy');
  const INITIALS = new Set(['', 'b', 'c', 'ch', 'd', 'g', 'gh', 'gi', 'h', 'k', 'kh', 'l', 'm', 'n', 'ng', 'ngh', 'nh', 'p', 'ph', 'q', 'qu', 'r', 's', 't', 'th', 'tr', 'v', 'x']);
  const FINALS = new Set(['', 'c', 'ch', 'm', 'n', 'ng', 'nh', 'p', 't']);
  // Vần (bỏ dấu mũ/móc) — kể cả nửa vần đang gõ dở như "uo" trước khi thêm w / 6.
  const RHYMES = new Set(('a e i o u y ai ao au ay eo eu ia ie iu oa oe oi oo ua ue ui uo uy uu ye ' +
    'oai oao oay oeo uay uoi uou uya uye uyu ieu yeu').split(' '));
  // Vần đã khép bằng bán âm — không có phụ âm cuối theo sau.
  const OPEN = new Set('ai ao au ay eo eu ia iu oi ui uu oai oao oay oeo uay uoi uou uya uyu ieu yeu'.split(' '));

  const METHODS = {
    telex: { tones: { s: 1, f: 2, r: 3, x: 4, j: 5, z: 0 }, keys: /^[a-z]$/i },
    vni: { tones: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 0: 0 }, keys: /^[a-z0-9]$/i },
  };

  // Một chữ: b chữ gốc (thường), up viết hoa, m dấu mũ/trăng/móc/gạch (đ).
  const letter = (ch) => {
    const lo = ch.toLowerCase(), p = PARSE[lo];
    return { b: p ? p.b : lo, up: ch !== lo, m: p ? p.m : '' };
  };
  const isVowel = (l) => l.m !== 'stroke' && VOWEL.has(l.b);

  // Tách từ thành phụ âm đầu · vần · phụ âm cuối. "gi" / "qu" đứng trước nguyên âm khác là phụ âm đầu.
  function split(ls) {
    let i = 0;
    while (i < ls.length && !isVowel(ls[i])) i++;
    if (i < ls.length - 1 && ls[i].b === 'u' && !ls[i].m && i === 1 && ls[0].b === 'q') i++;
    else if (i < ls.length - 1 && ls[i].b === 'i' && !ls[i].m && i === 1 && ls[0].b === 'g' && isVowel(ls[i + 1])) i++;
    let j = i;
    while (j < ls.length && isVowel(ls[j])) j++;
    return { i, j };   // ls[0..i) đầu · ls[i..j) vần · ls[j..) cuối
  }

  const str = (ls) => ls.map((l) => (l.m === 'stroke' ? 'đ' : l.b)).join('');

  function valid(ls, tone) {
    const { i, j } = split(ls);
    const head = str(ls.slice(0, i)).replace('đ', 'd'), rhyme = str(ls.slice(i, j)), tail = ls.slice(j);
    if (!INITIALS.has(head) || tail.some(isVowel) || !FINALS.has(str(tail))) return false;
    if (tail.some((l) => l.m)) return false;
    if (!rhyme) return !tone;
    if (!RHYMES.has(rhyme) || (tail.length && OPEN.has(rhyme))) return false;
    if (/^(k|gh|ngh)$/.test(head) && !/^[eiy]/.test(rhyme)) return false;
    if (/^(c|ng)$/.test(head) && /^[ei]/.test(rhyme) || head === 'g' && /^e/.test(rhyme)) return false;
    if (head === 'q') return false;
    // Phụ âm cuối tắc (c ch p t) chỉ đi với sắc / nặng.
    if (/^(c|ch|p|t)$/.test(str(tail)) && tone && tone !== 1 && tone !== 5) return false;
    return true;
  }

  // Chữ nhận thanh trong vần ls[i..j).
  function toneAt(ls, i, j, modern) {
    const r = ls.slice(i, j), n = r.length;
    if (!n) return -1;
    const horn = r.findIndex((l, k) => l.b === 'o' && l.m === 'horn' && k > 0 && r[k - 1].b === 'u');
    if (horn >= 0) return i + horn;                          // ươ → ơ
    const mk = r.findIndex((l) => l.m);
    if (mk >= 0) return i + mk;                               // â ê ô ơ ư ă
    if (n === 1) return i;
    if (n === 3) return i + 1;                                // oai, uya, oeo…
    if (j < ls.length) return i + 1;                          // có phụ âm cuối: toán, tuyết
    const pair = r[0].b + r[1].b;
    if (pair === 'oa' || pair === 'oe' || pair === 'uy') return i + (modern ? 1 : 0);   // hòa / hoà
    return i;
  }

  function render(ls, tone, modern) {
    const { i, j } = split(ls);
    const at = tone ? toneAt(ls, i, j, modern) : -1;
    return ls.map((l, k) => {
      let ch = l.m === 'stroke' ? 'đ' : (MARKED[l.b]?.[l.m] || l.b);
      if (k === at) ch = TONED[ch][tone];
      return l.up ? ch.toUpperCase() : ch;
    }).join('');
  }

  // Áp một phím lên từ. Trả về false khi phím chỉ là chữ thường (nối vào cuối).
  function apply(w, key, method) {
    const ls = w.ls, k = key.toLowerCase(), M = METHODS[method];
    const { i, j } = split(ls);
    const rhyme = ls.slice(i, j);
    // Đổi dấu của các chữ trong `targets`; đã có đủ dấu rồi thì gõ lần nữa là bỏ dấu, nối phím vào.
    const mark = (targets, m) => {
      if (!targets.length) return false;
      if (targets.every((l) => l.m === m)) { for (const l of targets) l.m = ''; w.undo = true; return false; }
      for (const l of targets) l.m = m;
      return true;
    };
    const horn = () => {
      const uo = rhyme.findIndex((l, x) => l.b === 'u' && rhyme[x + 1]?.b === 'o');
      if (uo >= 0) return mark([rhyme[uo], rhyme[uo + 1]], 'horn');
      const ua = rhyme[0]?.b === 'u' && rhyme[1]?.b === 'a' ? [rhyme[0]] : null;
      return mark(ua || [rhyme.find((l) => l.b === 'o') || rhyme.find((l) => l.b === 'u')].filter(Boolean), 'horn');
    };
    const stroke = () => (ls[0]?.b === 'd' ? mark([ls[0]], 'stroke') : false);

    if (k in M.tones) {
      if (!rhyme.length) return false;
      const t = M.tones[k];
      if (t === 0) { if (!w.tone) return false; w.tone = 0; return true; }
      if (w.tone === t) { w.tone = 0; w.undo = true; return false; }
      w.tone = t;
      return true;
    }
    if (method === 'telex') {
      if (k === 'd') return stroke();
      if (k === 'a' || k === 'e' || k === 'o') return mark(rhyme.filter((l) => l.b === k).slice(-1), 'hat');
      if (k === 'w') {
        const a = rhyme.find((l) => l.b === 'a');
        if (a && !rhyme.some((l, x) => l.b === 'u' && rhyme[x + 1]?.b === 'o') && !(rhyme[0]?.b === 'u' && rhyme[1] === a)) return mark([a], 'breve');
        if (rhyme.length) return horn();
        // "w" đứng một mình sau phụ âm đầu (hoặc đầu từ) là ư: tw → tư.
        if (!w.undo) { ls.push({ b: 'u', up: key !== k, m: 'horn' }); return true; }
        return false;
      }
      return false;
    }
    // VNI
    if (k === '9') return stroke();
    if (k === '6') return mark(rhyme.filter((l) => 'aeo'.includes(l.b)).slice(-1), 'hat');
    if (k === '8') return mark(rhyme.filter((l) => l.b === 'a').slice(-1), 'breve');
    if (k === '7') return horn();
    return false;
  }

  // Dựng từ: `base` là chữ đã có trên màn hình lúc bắt đầu (sau backspace), `keys` là các phím gõ thêm.
  function compose(base, keys, method, modern) {
    const w = { ls: [], tone: 0, undo: false };
    for (const ch of base) {
      w.ls.push(letter(ch));
      const t = PARSE[ch.toLowerCase()]?.t;
      if (t) w.tone = t;
    }
    let changed = false;
    for (const key of keys) {
      if (apply(w, key, method)) changed = true;
      else w.ls.push(letter(key));
    }
    const out = render(w.ls, w.tone, modern);
    if (!changed && !w.undo && !w.tone) return out;
    return valid(w.ls, w.tone) ? out : base + keys;
  }

  // ─── Gắn vào xterm ──────────────────────────────────────────────────────
  // opts.config() → { method: 'off'|'telex'|'vni', modern } — đọc mỗi phím nên đổi cài đặt là có
  // hiệu lực ngay. opts.onToggle() khi bấm rồi nhả ⌃⇧, opts.onForeign() khi phím tới đã là chữ
  // Việt (bộ gõ của máy đang chạy). opts.el: phần tử bọc xterm (bấm chuột / dán → từ mới).
  function attach(term, opts) {
    let base = '', keys = '', shown = '', ate = false, chord = false;
    const reset = () => { base = keys = shown = ''; };
    const send = (next) => {
      let p = 0;
      while (p < shown.length && p < next.length && shown[p] === next[p]) p++;
      const data = '\x7f'.repeat(shown.length - p) + next.slice(p);
      shown = next;
      if (data) term.input(data, true);
    };

    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keypress') return !ate;
      if (e.type === 'keyup') {
        if (chord && (e.key === 'Control' || e.key === 'Shift')) { chord = false; reset(); opts.onToggle?.(); }
        return true;
      }
      ate = false;
      chord = (e.key === 'Control' || e.key === 'Shift') && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
      const cfg = opts.config();
      const M = METHODS[cfg.method];
      if (!M) { reset(); return true; }
      if (e.isComposing || e.keyCode === 229 || e.key === 'Process' || e.key === 'Dead') { reset(); return true; }
      if (e.key.length === 1 && VN_CHAR.test(e.key)) { reset(); opts.onForeign?.(); return true; }
      if (e.ctrlKey || e.metaKey || e.altKey) { if (!/^(Control|Shift|Alt|Meta)$/.test(e.key)) reset(); return true; }
      if (e.key === 'Shift' || e.key === 'CapsLock') return true;
      if (e.key === 'Backspace') {
        if (shown) { base = shown.slice(0, -1); keys = ''; shown = base; }
        return true;
      }
      if (e.key.length !== 1 || !M.keys.test(e.key)) { reset(); return true; }
      // VNI: số đứng đầu từ là số thật.
      if (!shown && !/^[a-z]$/i.test(e.key)) return true;
      keys += e.key;
      send(compose(base, keys, cfg.method, cfg.modern));
      ate = true;
      e.preventDefault();
      return false;
    });
    // Con trỏ có thể đã dời (bấm chuột trong Claude Code, dán chữ) — bắt đầu từ mới.
    for (const ev of ['mousedown', 'paste', 'blur']) opts.el?.addEventListener(ev, reset, true);
    return { reset };
  }

  const api = { compose, attach, isVietnamese: (s) => VN_CHAR.test(s) };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VnKey = api;
})(typeof self !== 'undefined' ? self : this);
