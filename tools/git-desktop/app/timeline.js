// Dòng thời gian của tab Review (git.html, chế độ IDE): mỗi lượt của agent có sửa tệp là một mốc —
// câu người dùng hỏi, câu trả lời cuối của agent, và diff từng tệp lượt đó sửa (patch agentd đọc từ
// transcript, như khung Chat). git.html không đọc được transcript nên xin qua postMessage; ở đây đọc
// nối tiếp theo offset và nhớ theo node, lần xin sau chỉ đọc phần mới.
'use strict';

const TL_TURNS = 150;        // mỗi agent giữ chừng ấy lượt có sửa tệp gần nhất
const TL_LINES = 4000;       // dòng diff tối đa mỗi tệp mỗi lượt

const Timeline = {
  cache: new Map(),          // nodeId → { sid, offset, msgs }

  // nodes: id các agent git.html xếp vào worktree đang xem. → mốc của mọi agent, chưa xếp theo giờ.
  async collect(nodes) {
    let agents = [];
    try { agents = await window.menorah.agents(); } catch {}
    const want = new Set(nodes);
    const list = agents.filter((a) => want.has(a.nodeId) && a.agent !== 'shell');
    for (const id of this.cache.keys()) if (!agents.some((a) => a.nodeId === id)) this.cache.delete(id);
    const out = await Promise.all(list.map(async (a) => {
      try { return this.turns(a, await this.read(a)); } catch { return []; }
    }));
    return out.flat();
  },

  async read(a) {
    let c = this.cache.get(a.nodeId);
    if (!c || c.sid !== a.sessionId) { c = { sid: a.sessionId, offset: 0, msgs: [] }; this.cache.set(a.nodeId, c); }
    const r = await window.menorah.chatRead({ nodeId: a.nodeId, agent: a.agent, sessionId: a.sessionId, offset: c.offset });
    if (!r || r.missing) return c.msgs;
    if (r.offset < c.offset) c.msgs = [];   // tệp bị viết lại
    c.msgs.push(...(r.messages || []));
    c.offset = r.offset;
    return c.msgs;
  },

  turns(a, msgs) {
    const results = new Map(msgs.filter((m) => m.role === 'result' && m.id).map((m) => [m.id, m]));
    const out = [];
    let t = null;
    for (const m of msgs) {
      if (m.role === 'user') {
        t = { id: `${a.nodeId}:${m.ts}`, nodeId: a.nodeId, agent: a.agent, title: a.title, ts: m.ts, end: m.ts, prompt: m.text || '', images: m.images || 0, reply: '', model: '', files: new Map() };
        out.push(t);
        continue;
      }
      if (!t || m.role === 'result') continue;
      if (m.ts) t.end = m.ts;
      if (m.role === 'assistant' && m.text) t.reply = m.text;
      if (m.model) t.model = m.model;
      if (m.role === 'tool') this.edit(t.files, m, m.id ? results.get(m.id) : null, a.cwd);
    }
    return out.filter((x) => x.files.size).slice(-TL_TURNS).map((x) => ({ ...x, running: false, files: [...x.files.entries()].map(([path, f]) => ({ path, ...f })) }))
      .map((x, i, all) => (i === all.length - 1 && a.status === 'running' ? { ...x, running: true } : x));
  },

  // Edit / MultiEdit / Write / NotebookEdit của Claude: hunk lấy từ patch, thiếu thì dựng từ input
  // (dòng bắt đầu 0 = không biết số dòng). apply_patch của Codex: chỉ còn tên tệp.
  edit(files, m, r, cwd) {
    if (r?.error) return;
    const i = m.input && typeof m.input === 'object' ? m.input : {};
    const abs = (p) => (/^(\/|[A-Za-z]:[\\/])/.test(p) ? p : `${cwd.replace(/[\\/]$/, '')}/${p}`);
    if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(m.name) && (i.file_path || i.notebook_path)) {
      const p = abs(i.file_path || i.notebook_path);
      const f = files.get(p) || { st: m.name === 'Write' && r && !r.patch?.length ? 'A' : 'M', add: 0, del: 0, hunks: [], cut: false, n: 0 };
      const hunks = r?.patch?.length ? r.patch : [{ oldStart: 0, newStart: 0, lines: diffLines(m, r) }];
      for (const x of hunks) {
        for (const l of x.lines) { if (l[0] === '+') f.add++; else if (l[0] === '-') f.del++; }
        if (f.n + x.lines.length > TL_LINES) { f.cut = true; continue; }
        f.n += x.lines.length;
        f.hunks.push({ oldStart: x.oldStart | 0, newStart: x.newStart | 0, lines: x.lines });
      }
      f.edits = (f.edits || 0) + 1;
      files.set(p, f);
    } else if (m.name === 'apply_patch') {
      for (const x of (m.text || '').matchAll(/\*\*\* (Update|Add|Delete) File: (\S+)/g)) {
        const p = abs(x[2]);
        if (!files.has(p)) files.set(p, { st: x[1][0] === 'U' ? 'M' : x[1][0], add: 0, del: 0, hunks: [], cut: false, n: 0, edits: 1, nodiff: true });
      }
    }
  },
};
