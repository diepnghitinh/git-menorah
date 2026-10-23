package main

// Phiên PTY: một phiên cho mỗi node terminal. Sống ở agentd, không ở renderer — đổi tab, tải lại
// trang hay đóng cửa sổ (macOS) không làm chết agent; mở lại thì gắn vào bộ đệm cũ.

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	bufMax    = 512 * 1024 // bộ đệm thô mỗi phiên, để gắn lại xterm
	runningMs = 1500       // có output trong khoảng này = "Đang chạy"
	flushWait = 8 * time.Millisecond
)

var (
	binDir   string // userData/bin của app — lệnh menorah-context nằm ở đây
	ctxURL   string
	ctxToken string
	isWin    = runtime.GOOS == "windows"
)

// Tiến trình con gắn PTY — proc_unix.go (creack/pty) và proc_windows.go (ConPTY).
type ptyProc interface {
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	Resize(cols, rows int) error
	Pid() int
	Kill()      // như node-pty: SIGHUP cho shell (Windows: tắt hẳn)
	Wait() int  // chờ thoát, trả mã thoát
	Close()     // đóng PTY sau khi tiến trình thoát
	KillGroup() // lúc tắt agentd: cả nhóm tiến trình
}

type session struct {
	nodeID    string
	agent     string
	cwd       string
	startedAt float64
	proc      ptyProc
	lastOut   atomic.Int64

	mu        sync.Mutex
	sessionID string
	buf       []byte
	exited    bool

	writes chan []byte
	done   chan struct{}
	// Chưa gửi trả lời pty-start thì chưa phát "data": JS gắn người xem khi nhận trả lời, và
	// canvas reset xterm lúc đó — dữ liệu đến trước sẽ mất.
	gate     chan struct{}
	gateOnce sync.Once
}

func (s *session) openGate() { s.gateOnce.Do(func() { close(s.gate) }) }

// Gọi sau khi đã gửi trả lời pty-start (main.go).
func openGates() {
	for _, s := range liveSessions() {
		s.openGate()
	}
}

type startOpts struct {
	NodeID    string `json:"nodeId"`
	Agent     string `json:"agent"`
	Cwd       string `json:"cwd"`
	SessionID string `json:"sessionId"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
}

var (
	sessMu   sync.Mutex
	sessions = map[string]*session{}
)

func getSession(id string) *session {
	sessMu.Lock()
	defer sessMu.Unlock()
	return sessions[id]
}

func liveSessions() []*session {
	sessMu.Lock()
	defer sessMu.Unlock()
	out := make([]*session, 0, len(sessions))
	for _, s := range sessions {
		out = append(out, s)
	}
	return out
}

func status(id string) string {
	s := getSession(id)
	if s == nil {
		return "stopped"
	}
	if float64(time.Now().UnixMilli()-s.lastOut.Load()) < runningMs {
		return "running"
	}
	return "idle"
}

// Session id của phiên đang chạy (Codex tìm ra sau khi mở), không có thì dùng id node đang lưu.
func liveSessionID(nodeID, fallback string) string {
	if s := getSession(nodeID); s != nil {
		s.mu.Lock()
		id := s.sessionID
		s.mu.Unlock()
		if id != "" {
			return id
		}
	}
	return fallback
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

const claudeFlags = "--permission-mode auto"

func agentCommand(agent, sessionID string) string {
	switch agent {
	case "claude":
		// Phiên gắn với node bằng session id cố định: tắt máy mở lại vẫn --resume đúng phiên.
		if claudeTranscript(sessionID) != "" {
			return "claude " + claudeFlags + " --resume " + sessionID
		}
		return "claude " + claudeFlags + " --session-id " + sessionID
	case "codex":
		if sessionID != "" {
			return "codex resume " + sessionID
		}
		return "codex"
	}
	return ""
}

// App mở từ một phiên agent (lúc chạy thử từ mã nguồn) thì đừng để biến của phiên đó lọt vào
// agent con: Claude Code coi là phiên con và tắt ghi transcript (khung Chat trống), lệnh canvas
// của nodeterm trỏ nhầm node. Biến cấu hình của người dùng (ANTHROPIC_*, EFFORT…) giữ.
var dropEnvRe = regexp.MustCompile(`^(CLAUDECODE$|CLAUDE_PID$|CLAUDE_CODE_(ENTRYPOINT|SSE_PORT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_\w+|EXECPATH)$|NODETERM_|ELECTRON_RUN_AS_NODE$|CODEX_THREAD_ID$)`)

func ptyEnv(nodeID string) []string {
	set := map[string]string{
		"TERM": "xterm-256color", "COLORTERM": "truecolor", "TERM_PROGRAM": "GitMenorah",
		"MENORAH_NODE_ID": nodeID, "MENORAH_CTX_URL": ctxURL, "MENORAH_CTX_TOKEN": ctxToken,
	}
	sep := ":"
	extra := []string{binDir, "/opt/homebrew/bin", "/usr/local/bin", filepath.Join(home, ".local/bin")}
	if isWin {
		sep, extra = ";", []string{binDir}
	}
	var env []string
	pathKey, pathVal := "PATH", ""
	for _, kv := range os.Environ() {
		k, v, _ := strings.Cut(kv, "=")
		if k == "" || dropEnvRe.MatchString(k) {
			continue
		}
		if strings.EqualFold(k, "PATH") {
			pathKey, pathVal = k, v
			continue
		}
		if _, ok := set[k]; ok {
			continue
		}
		env = append(env, kv)
	}
	// App mở từ Finder/Dock không có LANG: pbcopy (Claude Code gọi khi copy) đọc byte UTF-8
	// thành Mac Roman → "có" thành "c√≥". Terminal.app luôn đặt LANG; ta cũng vậy.
	if !isWin && !hasLocale(env) {
		env = append(env, "LANG=en_US.UTF-8")
	}
	parts := []string{}
	for _, p := range append(extra, pathVal) {
		if p != "" {
			parts = append(parts, p)
		}
	}
	env = append(env, pathKey+"="+strings.Join(parts, sep))
	for k, v := range set {
		env = append(env, k+"="+v)
	}
	return env
}

func hasLocale(env []string) bool {
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		if v != "" && (k == "LANG" || k == "LC_ALL" || k == "LC_CTYPE") {
			return true
		}
	}
	return false
}

func ptyStart(o startOpts) (map[string]any, error) {
	if o.NodeID == "" {
		return nil, fmt.Errorf("nodeId missing")
	}
	sessMu.Lock()
	s := sessions[o.NodeID]
	sessMu.Unlock()
	if s != nil {
		if o.Cols > 0 && o.Rows > 0 {
			_ = s.proc.Resize(o.Cols, o.Rows)
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		return map[string]any{"buffer": string(s.buf), "sessionId": s.sessionID, "attached": len(s.buf) > 0, "started": false}, nil
	}

	cwd := o.Cwd
	if st, err := os.Stat(cwd); cwd == "" || err != nil || !st.IsDir() {
		cwd = home
	}
	sid := o.SessionID
	if sid == "" && o.Agent == "claude" {
		sid = newUUID()
	}
	cols, rows := o.Cols, o.Rows
	if cols <= 0 {
		cols = 100
	}
	if rows <= 0 {
		rows = 30
	}
	cols, rows = max(20, cols), max(5, rows)

	proc, err := spawnPty(agentCommand(o.Agent, sid), cwd, ptyEnv(o.NodeID), cols, rows)
	if err != nil {
		return nil, err
	}
	s = &session{
		nodeID: o.NodeID, agent: o.Agent, cwd: cwd, startedAt: nowMs(), proc: proc, sessionID: sid,
		writes: make(chan []byte, 1024), done: make(chan struct{}), gate: make(chan struct{}),
	}
	sessMu.Lock()
	sessions[o.NodeID] = s
	sessMu.Unlock()
	go s.writeLoop()
	go s.run()
	if o.Agent == "codex" && sid == "" {
		go s.discover()
	}
	return map[string]any{"buffer": "", "sessionId": sid, "attached": false, "started": true}, nil
}

// Ghi phím gõ ở goroutine riêng: tiến trình con đang bị hãm (SIGSTOP) không đọc PTY, ghi sẽ
// nghẽn — không được để nghẽn vòng đọc stdin của cả agentd.
func (s *session) writeLoop() {
	for {
		select {
		case b := <-s.writes:
			if _, err := s.proc.Write(b); err != nil {
				return
			}
		case <-s.done:
			return
		}
	}
}

func (s *session) write(data string) {
	if data == "" {
		return
	}
	select {
	case s.writes <- []byte(data):
	case <-s.done:
	default:
		logf("%s: write queue full, dropped %d bytes", s.nodeID, len(data))
	}
}

func (s *session) resize(cols, rows int) { _ = s.proc.Resize(cols, rows) }
func (s *session) kill()                 { s.proc.Kill() }

// Đọc PTY → bộ đệm + gom 8ms rồi phát "data"; tiến trình thoát → phát nốt rồi "exit".
func (s *session) run() {
	chunks := make(chan []byte, 256)
	go func() {
		defer close(chunks)
		b := make([]byte, 32*1024)
		var rest []byte
		for {
			n, err := s.proc.Read(b)
			if n > 0 {
				whole, r := splitUTF8(append(rest, b[:n]...))
				rest = append([]byte(nil), r...)
				if len(whole) > 0 {
					c := append([]byte(nil), whole...)
					s.mu.Lock()
					s.buf = append(s.buf, c...)
					if len(s.buf) > bufMax {
						s.buf = append([]byte(nil), keepTail(s.buf, bufMax*3/4)...)
					}
					s.mu.Unlock()
					s.lastOut.Store(time.Now().UnixMilli())
					chunks <- c
				}
			}
			if err != nil {
				return
			}
		}
	}()

	codeCh := make(chan int, 1)
	go func() { codeCh <- s.proc.Wait() }()

	var pending []byte
	var flushC <-chan time.Time
	flush := func() {
		<-s.gate
		if len(pending) > 0 {
			emit("data", map[string]any{"nodeId": s.nodeID, "data": string(pending)})
			pending = nil
		}
		flushC = nil
	}
	code, exited := 0, false
	var drainC <-chan time.Time
	for chunks != nil {
		select {
		case c, ok := <-chunks:
			if !ok {
				chunks = nil
				break
			}
			pending = append(pending, c...)
			if flushC == nil {
				flushC = time.After(flushWait)
			}
		case <-flushC:
			flush()
		case code = <-codeCh:
			// Tiến trình đã thoát nhưng con cháu chạy nền có thể còn giữ PTY — đọc nốt một chút
			// rồi đóng, khỏi chờ mãi.
			exited, codeCh = true, nil
			drainC = time.After(300 * time.Millisecond)
		case <-drainC:
			s.proc.Close()
			drainC = nil
		}
	}
	flush()
	if !exited {
		code = <-codeCh
	}
	s.proc.Close()
	s.mu.Lock()
	s.exited = true
	s.mu.Unlock()
	close(s.done)
	sessMu.Lock()
	if sessions[s.nodeID] == s {
		delete(sessions, s.nodeID)
	}
	sessMu.Unlock()
	emit("exit", map[string]any{"nodeId": s.nodeID, "code": code})
}

// Codex mới chưa biết session id: 3 giây dò một lần, tối đa 15 phút.
func (s *session) discover() {
	t := time.NewTicker(3 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-t.C:
		}
		claimed := map[string]bool{}
		for _, x := range liveSessions() {
			x.mu.Lock()
			if x.sessionID != "" {
				claimed[x.sessionID] = true
			}
			x.mu.Unlock()
		}
		if id := discoverCodex(s.startedAt, s.cwd, claimed); id != "" {
			s.mu.Lock()
			s.sessionID = id
			s.mu.Unlock()
			emit("session", map[string]any{"nodeId": s.nodeID, "sessionId": id})
			return
		}
		if nowMs()-s.startedAt > 15*60e3 {
			return
		}
	}
}

// Bộ đệm thô của phiên (cho menorah-context terminal).
func sessionBuffer(id string) (string, bool) {
	s := getSession(id)
	if s == nil {
		return "", false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return string(s.buf), true
}

// agentd sắp thoát: tắt mọi phiên, chờ tối đa 1 giây cho chúng thoát hẳn.
func killAll() {
	list := liveSessions()
	for _, s := range list {
		s.proc.KillGroup()
	}
	deadline := time.After(time.Second)
	for _, s := range list {
		select {
		case <-s.done:
		case <-deadline:
			return
		}
	}
}
