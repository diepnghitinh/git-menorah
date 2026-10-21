// Nói chuyện với menorah-agentd (Go, mã ở agentd/) — tiến trình con lo PTY, giới hạn CPU / RAM,
// transcript Claude / Codex, sub agent, tai thỏ và cổng menorah-context.
//
// Giao thức: mỗi dòng một JSON qua stdin / stdout (xem đầu agentd/main.go).
//   call(op, a) → Promise kết quả;  send(op, a) → không chờ trả lời
//   onEvent({ ev, ... }) — data | exit | session | alert | ready
//
// agentd chết bất thường (crash, bị tắt): báo onCrash để backend đánh dấu mọi phiên đã thoát,
// rồi chạy lại sau 1 giây. App thoát thì stop(): đóng stdin, agentd tự tắt hết phiên rồi thoát.
// Electron chết đột ngột cũng làm stdin đóng — không để agent mồ côi.

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EXE = process.platform === 'win32' ? 'menorah-agentd.exe' : 'menorah-agentd';

// Gói build: <app>/bin/. Chạy từ mã nguồn: tools/git-desktop/bin/ (npm run agentd).
function agentdPath() {
  return path.join(__dirname, '..', 'bin', EXE);
}

function createAgentd({ onEvent, onCrash, onReady }) {
  let child = null;
  let seq = 0;
  let stopping = false;
  let restartT = null;
  let readyInfo = null;
  let readyWait = [];
  const pending = new Map(); // id → { resolve, reject }

  function failPending(msg) {
    for (const p of pending.values()) p.reject(new Error(msg));
    pending.clear();
  }

  function start() {
    const file = agentdPath();
    if (!fs.existsSync(file)) {
      const err = new Error(`${file} not found — run: npm run agentd (needs Go)`);
      for (const w of readyWait) w.reject(err);
      readyWait = [];
      readyInfo = { error: err.message };
      return;
    }
    child = spawn(file, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const me = child;
    let rest = '';
    me.stdout.setEncoding('utf8');
    me.stdout.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id) {
          const p = pending.get(m.id);
          if (!p) continue;
          pending.delete(m.id);
          if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
        } else if (m.ev === 'ready') {
          readyInfo = m;
          for (const w of readyWait) w.resolve(m);
          readyWait = [];
          onReady?.(m);
        } else setImmediate(onEvent, m); // sau trả lời pty-start: backend kịp ghi cửa sổ đang xem
      }
    });
    me.stderr.setEncoding('utf8');
    me.stderr.on('data', (d) => process.stderr.write(d));
    me.stdin.on('error', () => {});
    me.on('error', (e) => process.stderr.write(`agentd: ${e.message}\n`));
    me.on('exit', (code, sig) => {
      if (child !== me) return;
      child = null;
      readyInfo = null;
      failPending('menorah-agentd stopped');
      if (stopping) return;
      process.stderr.write(`agentd exited (${code ?? sig}) — restarting in 1 second\n`);
      onCrash?.();
      restartT = setTimeout(start, 1000);
    });
  }

  function write(obj) {
    if (!child) return false;
    child.stdin.write(`${JSON.stringify(obj)}\n`);
    return true;
  }

  return {
    start,
    ready: () => (readyInfo?.ev ? Promise.resolve(readyInfo)
      : readyInfo?.error ? Promise.reject(new Error(readyInfo.error))
        : new Promise((resolve, reject) => readyWait.push({ resolve, reject }))),
    info: () => readyInfo,
    call(op, a) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        if (!write({ id, op, a })) { pending.delete(id); reject(new Error('menorah-agentd is not running')); }
      });
    },
    send(op, a) { write({ op, a }); },
    // Đóng stdin là lệnh tắt: agentd tắt mọi phiên, cho cây con đang bị hãm chạy lại, rồi thoát.
    stop() {
      stopping = true;
      clearTimeout(restartT);
      try { child?.stdin.end(); } catch {}
    },
  };
}

module.exports = { createAgentd, agentdPath };
