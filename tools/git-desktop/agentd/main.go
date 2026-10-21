// menorah-agentd — phần chạy terminal agent của GitMenorah, tách khỏi tiến trình chính Electron.
//
// workspace/agentd.cjs chạy tệp này làm tiến trình con và nói chuyện qua stdin/stdout, mỗi dòng
// một JSON:
//
//	vào:  {"id":1,"op":"pty-start",...}   → ra: {"id":1,"result":...} | {"id":1,"error":"..."}
//	vào:  {"op":"pty-write",...}          (không có id = không trả lời)
//	ra:   {"ev":"data"|"exit"|"session"|"alert"|"ready",...}
//
// Tệp này lo: phiên PTY (session.go), giới hạn CPU / RAM (limits.go), transcript Claude / Codex,
// sub agent, tai thỏ (transcript.go) và cổng menorah-context (context.go). Canvas và project vẫn
// do JS lưu; JS gửi sơ đồ nối dây sang bằng op "canvas".
//
// stdin đóng (app thoát, crash, Force Quit) = tắt mọi phiên rồi thoát — không để agent mồ côi.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime/debug"
	"sync"
)

type request struct {
	ID int64           `json:"id"`
	Op string          `json:"op"`
	A  json.RawMessage `json:"a"`
}

var (
	outMu  sync.Mutex
	outEnc = func() *json.Encoder {
		e := json.NewEncoder(os.Stdout) // mỗi Encode là một lần Write

		e.SetEscapeHTML(false)
		return e
	}()
)

// Mọi dòng ra stdout đi qua đây — một dòng một lần ghi, không xen nhau giữa các goroutine.
func send(v any) {
	outMu.Lock()
	defer outMu.Unlock()
	_ = outEnc.Encode(v)
}

func emit(ev string, fields map[string]any) {
	m := map[string]any{"ev": ev}
	for k, v := range fields {
		m[k] = v
	}
	send(m)
}

func logf(format string, a ...any) { fmt.Fprintf(os.Stderr, "agentd: "+format+"\n", a...) }

func main() {
	ctx, err := startContextServer()
	if err != nil {
		logf("could not open the context port: %v", err)
		os.Exit(1)
	}
	limiter = newLimiter()
	limiter.start()
	emit("ready", map[string]any{"pid": os.Getpid(), "ctx": ctx, "limitsSupported": limitsSupported})

	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		line, err := in.ReadBytes('\n')
		if len(line) > 1 {
			var r request
			if json.Unmarshal(line, &r) != nil {
				logf("unreadable line: %.80s", line)
			} else {
				dispatch(r)
			}
		}
		if err != nil {
			if err != io.EOF {
				logf("stdin: %v", err)
			}
			shutdown()
			os.Exit(0)
		}
	}
}

// Op nhanh (ghi, đổi cỡ) chạy ngay trên vòng đọc để giữ thứ tự gõ phím; op đọc tệp chạy riêng
// để transcript lớn không chặn phím gõ của phiên khác.
func dispatch(r request) {
	switch r.Op {
	case "pty-write", "pty-resize", "pty-kill", "pty-start", "status", "canvas", "canvas-drop", "init", "limits-set", "limits":
		reply(r)
	default:
		go reply(r)
	}
}

func reply(r request) {
	defer func() {
		if p := recover(); p != nil {
			logf("panic in %s: %v\n%s", r.Op, p, debug.Stack())
			if r.ID != 0 {
				send(map[string]any{"id": r.ID, "error": fmt.Sprint(p)})
			}
		}
	}()
	res, err := handle(r.Op, r.A)
	if r.Op == "pty-start" {
		defer openGates()
	}
	if r.ID == 0 {
		return
	}
	if err != nil {
		send(map[string]any{"id": r.ID, "error": err.Error()})
		return
	}
	send(map[string]any{"id": r.ID, "result": res})
}

func handle(op string, a json.RawMessage) (any, error) {
	switch op {
	case "init":
		var x struct {
			BinDir string `json:"binDir"`
		}
		if err := json.Unmarshal(a, &x); err != nil {
			return nil, err
		}
		binDir = x.BinDir
		return true, nil
	case "pty-start":
		var o startOpts
		if err := json.Unmarshal(a, &o); err != nil {
			return nil, err
		}
		return ptyStart(o)
	case "pty-write":
		var x struct {
			NodeID string `json:"nodeId"`
			Data   string `json:"data"`
		}
		if json.Unmarshal(a, &x) == nil {
			if s := getSession(x.NodeID); s != nil {
				s.write(x.Data)
			}
		}
		return nil, nil
	case "pty-resize":
		var x struct {
			NodeID     string `json:"nodeId"`
			Cols, Rows int
		}
		if json.Unmarshal(a, &x) == nil && x.Cols > 0 && x.Rows > 0 {
			if s := getSession(x.NodeID); s != nil {
				s.resize(x.Cols, x.Rows)
			}
		}
		return nil, nil
	case "pty-kill":
		var x struct {
			NodeIDs []string `json:"nodeIds"`
		}
		if err := json.Unmarshal(a, &x); err != nil {
			return nil, err
		}
		for _, id := range x.NodeIDs {
			if s := getSession(id); s != nil {
				s.kill()
			}
		}
		return true, nil
	case "status":
		var ids []string
		if err := json.Unmarshal(a, &ids); err != nil {
			return nil, err
		}
		out := map[string]string{}
		for _, id := range ids {
			out[id] = status(id)
		}
		return out, nil
	case "chat-read":
		var x struct {
			NodeID    string `json:"nodeId"`
			Agent     string `json:"agent"`
			SessionID string `json:"sessionId"`
			Offset    int64  `json:"offset"`
		}
		if err := json.Unmarshal(a, &x); err != nil {
			return nil, err
		}
		sid := liveSessionID(x.NodeID, x.SessionID)
		f := transcriptFile(x.Agent, sid)
		if f == "" {
			return map[string]any{"messages": []message{}, "offset": 0, "missing": true, "sessionId": sid}, nil
		}
		r := readTranscript(f, x.Agent, x.Offset)
		r["sessionId"] = sid
		return r, nil
	case "subagents":
		var list []struct {
			NodeID    string `json:"nodeId"`
			SessionID string `json:"sessionId"`
		}
		if err := json.Unmarshal(a, &list); err != nil {
			return nil, err
		}
		if len(list) > 50 {
			list = list[:50]
		}
		cutoff := nowMs() - 15*60e3
		out := map[string][]subagent{}
		for _, x := range list {
			keep := []subagent{}
			for _, s := range subagents(liveSessionID(x.NodeID, x.SessionID)) {
				if s.State == "running" || s.Last > cutoff {
					keep = append(keep, s)
				}
			}
			out[x.NodeID] = keep
		}
		return out, nil
	case "agents", "notch":
		var list []nodeRef
		if err := json.Unmarshal(a, &list); err != nil {
			return nil, err
		}
		if op == "agents" {
			return agentsInfo(list), nil
		}
		return notchInfo(list), nil
	case "canvas":
		var x struct {
			CanvasID string    `json:"canvasId"`
			Nodes    []ctxNode `json:"nodes"`
			Links    []ctxLink `json:"links"`
		}
		if err := json.Unmarshal(a, &x); err != nil {
			return nil, err
		}
		setCanvas(x.CanvasID, x.Nodes, x.Links)
		return true, nil
	case "canvas-drop":
		var id string
		if err := json.Unmarshal(a, &id); err != nil {
			return nil, err
		}
		dropCanvas(id)
		return true, nil
	case "limits":
		return limiter.get(), nil
	case "limits-set":
		var l limits
		if err := json.Unmarshal(a, &l); err != nil {
			return nil, err
		}
		limiter.set(l)
		return limiter.get(), nil
	}
	return nil, fmt.Errorf("unknown op: %s", op)
}

func shutdown() {
	limiter.stop()
	killAll()
}
