// Báo trước khi prompt cache của một phiên Claude nguội.
//
// Cache sống CacheTTL (thường 1 giờ) kể từ request cuối. Qua mốc đó, prompt kế tiếp phải ghi
// lại cả system prompt, CLAUDE.md, tool và lịch sử chat từ đầu — tốn token. Còn ít phút thì đẩy
// một thông báo; bấm vào là mở đúng node để prompt tiếp hoặc chạy /compact (compact lúc cache
// còn ấm thì rẻ, lần sau quay lại chỉ phải đọc bản tóm tắt).
//
// Dữ liệu lấy từ notchList() (agentd đọc transcript): chỉ phiên đang sống, mỗi lần quét 30s.
// Phiên đang chạy thì cache liên tục được làm mới, phiên vừa /compact thì cache cũ hết giá trị —
// cả hai đều bỏ qua.

const { Notification } = require('electron');

const EVERY = 30e3;
const DEFAULT_TTL = 3600;   // transcript chưa cho biết TTL (chưa request nào ghi cache)

// Báo trước bao lâu: 5 phút, cache 5 phút thì 1 phút.
const leadMs = (ttlS) => Math.min(5 * 60e3, (ttlS * 1e3) / 5);
const cacheEnd = (it) => (it.cacheAt ? it.cacheAt + (it.cacheTtl || DEFAULT_TTL) * 1e3 : 0);

function createCacheWatch({ list, go }) {
  const shown = new Map();   // nodeId → { cacheAt, note } — giữ tham chiếu, không thì GC nuốt sự kiện click
  let timer = null;

  const drop = (id) => { shown.get(id)?.note?.close(); shown.delete(id); };

  async function tick() {
    let items;
    try { items = await list(); } catch { return; }
    const now = Date.now(), live = new Set();
    for (const it of items) {
      if (it.agent !== 'claude') continue;
      live.add(it.nodeId);
      const end = cacheEnd(it), prev = shown.get(it.nodeId);
      // Có request mới hoặc đã compact: thông báo cũ hết đúng — gỡ đi.
      if (prev && (prev.cacheAt !== it.cacheAt || it.compacted || it.status === 'running')) drop(it.nodeId);
      if (!end || it.compacted || it.status === 'running' || shown.has(it.nodeId)) continue;
      const left = end - now;
      if (left <= 0 || left > leadMs(it.cacheTtl || DEFAULT_TTL)) continue;
      const mins = Math.max(1, Math.round(left / 60e3));
      const where = [it.projectName, it.canvasName].filter(Boolean).join(' / ');
      const note = new Notification({
        title: `Prompt cache cools in ${mins} min`,
        subtitle: it.title || 'Claude',
        body: `${where ? where + ' — ' : ''}click to open the session, then prompt or run /compact.`,
      });
      note.on('click', () => { drop(it.nodeId); go({ projectId: it.projectId, nodeId: it.nodeId, canvasId: it.canvasId }); });
      note.show();
      shown.set(it.nodeId, { cacheAt: it.cacheAt, note });
    }
    for (const id of [...shown.keys()]) if (!live.has(id)) drop(id);
  }

  return {
    start() {
      if (timer || !Notification.isSupported()) return;
      timer = setInterval(tick, EVERY);
      tick();
    },
    stop() {
      clearInterval(timer);
      timer = null;
      for (const id of [...shown.keys()]) drop(id);
    },
  };
}

module.exports = { createCacheWatch };
