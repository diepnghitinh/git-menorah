package main

// Transcript của Claude Code và Codex → tin nhắn gọn cho khung Chat, sub agent, tai thỏ.
//
// Claude: ~/.claude/projects/<cwd dạng slug>/<sessionId>.jsonl — tìm theo tên tệp ở mọi thư mục
// con, khỏi đoán quy tắc slug. Codex: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl, dòng đầu
// là session_meta có id + cwd.
//
// Đọc tệp theo từng dòng (bufio), không nạp cả tệp: transcript 100 MB chỉ tốn vài MB RAM.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	home           = mustHome()
	claudeProjects = filepath.Join(envOr("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude")), "projects")
	codexSessions  = filepath.Join(envOr("CODEX_HOME", filepath.Join(home, ".codex")), "sessions")
)

func mustHome() string { h, _ := os.UserHomeDir(); return h }
func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// ─── Tìm tệp ────────────────────────────────────────────────────────────────

var claudeFiles sync.Map // sessionId → đường dẫn đã tìm thấy (poll sub agent gọi liên tục)

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func claudeTranscript(sessionID string) string {
	if sessionID == "" {
		return ""
	}
	if v, ok := claudeFiles.Load(sessionID); ok && exists(v.(string)) {
		return v.(string)
	}
	entries, err := os.ReadDir(claudeProjects)
	if err != nil {
		return ""
	}
	for _, d := range entries {
		f := filepath.Join(claudeProjects, d.Name(), sessionID+".jsonl")
		if exists(f) {
			claudeFiles.Store(sessionID, f)
			return f
		}
	}
	return ""
}

func codexDayDirs(days int) []string {
	out := make([]string, 0, days)
	for i := 0; i < days; i++ {
		d := time.Now().Add(-time.Duration(i) * 24 * time.Hour)
		out = append(out, filepath.Join(codexSessions, fmt.Sprint(d.Year()), fmt.Sprintf("%02d", int(d.Month())), fmt.Sprintf("%02d", d.Day())))
	}
	return out
}

type codexSessionMeta struct {
	ID  string `json:"id"`
	Cwd string `json:"cwd"`
}

func codexMeta(file string) *codexSessionMeta {
	fh, err := os.Open(file)
	if err != nil {
		return nil
	}
	defer fh.Close()
	b := make([]byte, 64*1024)
	n, _ := io.ReadFull(fh, b)
	line := b[:n]
	if i := bytes.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	var j struct {
		Type    string            `json:"type"`
		Payload *codexSessionMeta `json:"payload"`
	}
	if json.Unmarshal(line, &j) != nil || j.Type != "session_meta" {
		return nil
	}
	return j.Payload
}

func codexTranscript(sessionID string) string {
	if sessionID == "" {
		return ""
	}
	for _, dir := range codexDayDirs(30) {
		names, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, n := range names {
			if strings.HasSuffix(n.Name(), sessionID+".jsonl") {
				return filepath.Join(dir, n.Name())
			}
		}
	}
	return ""
}

// Phiên Codex mới chưa biết id: tìm rollout ghi sau lúc mở, cùng cwd, chưa node nào nhận.
// (mtime luôn ≥ lúc tạo, nên chỉ cần xét mtime.)
func discoverCodex(startedAt float64, cwd string, claimed map[string]bool) string {
	want := filepath.Clean(cwd)
	for _, dir := range codexDayDirs(2) {
		names, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, n := range names {
			name := n.Name()
			if !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
				continue
			}
			f := filepath.Join(dir, name)
			st, err := os.Stat(f)
			if err != nil || float64(st.ModTime().UnixMilli()) < startedAt-5000 {
				continue
			}
			if m := codexMeta(f); m != nil && m.ID != "" && !claimed[m.ID] && filepath.Clean(m.Cwd) == want {
				return m.ID
			}
		}
	}
	return ""
}

func transcriptFile(agent, sessionID string) string {
	switch agent {
	case "claude":
		return claudeTranscript(sessionID)
	case "codex":
		return codexTranscript(sessionID)
	}
	return ""
}

// ─── Parse ──────────────────────────────────────────────────────────────────

type message struct {
	Role   string  `json:"role"` // user | assistant | tool | note
	Text   string  `json:"text"`
	Name   string  `json:"name,omitempty"`
	Images int     `json:"images,omitempty"`
	Error  bool    `json:"error,omitempty"`
	Ts     float64 `json:"ts"`
}

type contentPart struct {
	Type    string          `json:"type"`
	Text    string          `json:"text"`
	Name    string          `json:"name"`
	Input   json.RawMessage `json:"input"`
	IsError bool            `json:"is_error"`
	Content json.RawMessage `json:"content"`
}

type usage struct {
	Input       float64 `json:"input_tokens"`
	CacheRead   float64 `json:"cache_read_input_tokens"`
	CacheCreate float64 `json:"cache_creation_input_tokens"`
	Output      float64 `json:"output_tokens"`
	CacheTTL    *struct {
		H1 float64 `json:"ephemeral_1h_input_tokens"`
		M5 float64 `json:"ephemeral_5m_input_tokens"`
	} `json:"cache_creation"`
}

func (u *usage) total() float64 { return u.Input + u.CacheRead + u.CacheCreate + u.Output }

// TTL (giây) của prompt cache mà request này ghi; 0 = request không ghi cache mới, chưa biết.
func (u *usage) ttl() float64 {
	switch {
	case u.CacheTTL == nil:
		return 0
	case u.CacheTTL.H1 > 0:
		return 3600
	case u.CacheTTL.M5 > 0:
		return 300
	}
	return 0
}

type claudeLine struct {
	Type             string `json:"type"`
	Subtype          string `json:"subtype"`
	IsSidechain      bool   `json:"isSidechain"`
	IsMeta           bool   `json:"isMeta"`
	IsCompactSummary bool   `json:"isCompactSummary"`
	Timestamp        string `json:"timestamp"`
	Message          *struct {
		Content    json.RawMessage `json:"content"`
		Model      string          `json:"model"`
		Usage      *usage          `json:"usage"`
		StopReason string          `json:"stop_reason"`
	} `json:"message"`
}

type codexLine struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Payload   *struct {
		Type      string            `json:"type"`
		Message   string            `json:"message"`
		Images    []json.RawMessage `json:"images"`
		Name      string            `json:"name"`
		Arguments json.RawMessage   `json:"arguments"`
		Input     json.RawMessage   `json:"input"`
		Action    json.RawMessage   `json:"action"`
		Model     string            `json:"model"`
		Info      *struct {
			Last *struct {
				Total *float64 `json:"total_tokens"`
			} `json:"last_token_usage"`
			Window float64 `json:"model_context_window"`
		} `json:"info"`
	} `json:"payload"`
}

var (
	commandNameRe = regexp.MustCompile(`<command-name>([^<]+)</command-name>`)
	hiddenUserRe  = regexp.MustCompile(`^\s*<(local-command|command-|bash-|system-reminder|task-notification)`)
	reminderRe    = regexp.MustCompile(`^\s*<(system-reminder|task-notification)>`)
)

// Giá trị JSON là chuỗi thì trả chuỗi đó.
func rawString(r json.RawMessage) (string, bool) {
	if len(r) == 0 || r[0] != '"' {
		return "", false
	}
	var s string
	if json.Unmarshal(r, &s) != nil {
		return "", false
	}
	return s, true
}

func isNullish(r json.RawMessage) bool {
	t := bytes.TrimSpace(r)
	return len(t) == 0 || string(t) == "null"
}

// Tóm tắt input của một tool cho khung Chat: lệnh, tệp, mẫu tìm… (khoá đầu tiên có giá trị).
// Không phải chuỗi thì in JSON gọn.
func toolBrief(input json.RawMessage) string {
	t := bytes.TrimSpace(input)
	if len(t) == 0 || t[0] != '{' && t[0] != '[' {
		return ""
	}
	if t[0] == '{' {
		var m map[string]json.RawMessage
		if json.Unmarshal(t, &m) == nil {
			for _, k := range []string{"command", "file_path", "path", "pattern", "url", "description", "prompt", "skill"} {
				v, ok := m[k]
				if !ok || isNullish(v) {
					continue
				}
				if s, ok := rawString(v); ok {
					return clip(collapseSpace(s), 160)
				}
				break
			}
		}
	}
	out, ok := jsStringify(t)
	if !ok {
		return ""
	}
	return clip(out, 160)
}

func parseClaudeLine(raw []byte) []message {
	var j claudeLine
	if json.Unmarshal(raw, &j) != nil {
		return nil
	}
	return claudeMessages(&j)
}

func claudeMessages(j *claudeLine) []message {
	if j.IsSidechain || j.IsMeta || j.IsCompactSummary {
		return nil
	}
	ts := parseTs(j.Timestamp)
	if j.Type == "system" && j.Subtype == "compact_boundary" {
		return []message{{Role: "note", Text: "Conversation compacted", Ts: ts}}
	}
	if (j.Type != "user" && j.Type != "assistant") || j.Message == nil {
		return nil
	}
	c := j.Message.Content
	if j.Type == "user" {
		if s, ok := rawString(c); ok {
			if m := commandNameRe.FindStringSubmatch(s); m != nil {
				return []message{{Role: "note", Text: jsTrim(m[1]), Ts: ts}}
			}
			if hiddenUserRe.MatchString(s) || strings.HasPrefix(s, "Caveat:") {
				return nil
			}
			return []message{{Role: "user", Text: s, Ts: ts}}
		}
		var parts []contentPart
		if json.Unmarshal(c, &parts) != nil {
			return nil
		}
		var texts []string
		images := 0
		for _, x := range parts {
			if x.Type == "text" && !reminderRe.MatchString(x.Text) {
				texts = append(texts, x.Text)
			}
			if x.Type == "image" {
				images++
			}
		}
		var out []message
		if text := strings.Join(texts, "\n"); text != "" || images > 0 {
			out = append(out, message{Role: "user", Text: text, Images: images, Ts: ts})
		}
		for _, r := range parts {
			if r.Type != "tool_result" || !r.IsError {
				continue
			}
			t, ok := rawString(r.Content)
			if !ok {
				var items []struct {
					Text string `json:"text"`
				}
				_ = json.Unmarshal(r.Content, &items)
				ss := make([]string, len(items))
				for i, it := range items {
					ss[i] = it.Text
				}
				t = strings.Join(ss, " ")
			}
			out = append(out, message{Role: "tool", Name: "Error", Text: clip(collapseSpace(t), 200), Error: true, Ts: ts})
		}
		return out
	}
	var parts []contentPart
	if json.Unmarshal(c, &parts) != nil {
		return nil
	}
	var out []message
	for _, x := range parts {
		if x.Type == "text" && jsTrim(x.Text) != "" {
			out = append(out, message{Role: "assistant", Text: x.Text, Ts: ts})
		}
		if x.Type == "tool_use" {
			out = append(out, message{Role: "tool", Name: x.Name, Text: toolBrief(x.Input), Ts: ts})
		}
	}
	return out
}

func parseCodexLine(raw []byte) []message {
	var j codexLine
	if json.Unmarshal(raw, &j) != nil {
		return nil
	}
	return codexMessages(&j)
}

func codexMessages(j *codexLine) []message {
	p := j.Payload
	if p == nil {
		return nil
	}
	ts := parseTs(j.Timestamp)
	if j.Type == "event_msg" && p.Type == "user_message" && p.Message != "" {
		return []message{{Role: "user", Text: p.Message, Images: len(p.Images), Ts: ts}}
	}
	if j.Type == "event_msg" && p.Type == "agent_message" && p.Message != "" {
		return []message{{Role: "assistant", Text: p.Message, Ts: ts}}
	}
	if j.Type == "response_item" && (p.Type == "function_call" || p.Type == "custom_tool_call" || p.Type == "local_shell_call") {
		input := p.Arguments
		if isNullish(input) {
			input = p.Input
		}
		if isNullish(input) {
			input = p.Action
		}
		var brief string
		if s, ok := rawString(input); ok {
			// arguments thường là JSON nằm trong chuỗi.
			if t := strings.TrimSpace(s); json.Valid([]byte(t)) {
				input = json.RawMessage(t)
			} else {
				brief = clip(s, 160)
				input = nil
			}
		}
		if input != nil {
			if s, ok := rawString(input); ok {
				brief = clip(s, 160)
			} else {
				var cmd struct {
					Command []string `json:"command"`
				}
				if json.Unmarshal(input, &cmd) == nil && cmd.Command != nil {
					brief = clip(strings.Join(cmd.Command, " "), 160)
				} else {
					brief = toolBrief(input)
				}
			}
		}
		name := p.Name
		if name == "" {
			name = "shell"
		}
		return []message{{Role: "tool", Name: name, Text: brief, Ts: ts}}
	}
	return nil
}

func parserFor(agent string) func([]byte) []message {
	if agent == "codex" {
		return parseCodexLine
	}
	return parseClaudeLine
}

// Đọc từng dòng trong [from, to) của tệp; dòng cuối không có '\n' thì bỏ (đang ghi dở).
// Trả vị trí byte ngay sau '\n' cuối cùng đã đọc.
func eachLine(file string, from, to int64, fn func([]byte)) (int64, error) {
	fh, err := os.Open(file)
	if err != nil {
		return from, err
	}
	defer fh.Close()
	r := bufio.NewReaderSize(io.NewSectionReader(fh, from, to-from), 256*1024)
	pos := from
	for {
		line, err := r.ReadSlice('\n')
		if err == bufio.ErrBufferFull {
			// Dòng dài hơn bộ đệm: gom đủ dòng rồi mới xử lý.
			full := append([]byte(nil), line...)
			for err == bufio.ErrBufferFull {
				line, err = r.ReadSlice('\n')
				full = append(full, line...)
			}
			line = full
		}
		if err != nil {
			return pos, nil // EOF: phần còn lại chưa có '\n'
		}
		pos += int64(len(line))
		if len(line) > 1 {
			fn(line[:len(line)-1])
		}
	}
}

// Đọc nối tiếp từ offset (byte). Dòng cuối chưa đủ thì để lần sau.
func readTranscript(file, agent string, offset int64) map[string]any {
	st, err := os.Stat(file)
	if err != nil {
		return map[string]any{"messages": []message{}, "offset": 0, "missing": true}
	}
	if st.Size() < offset { // tệp bị viết lại
		offset = 0
	}
	msgs := []message{}
	if st.Size() == offset {
		return map[string]any{"messages": msgs, "offset": offset}
	}
	parse := parserFor(agent)
	end, _ := eachLine(file, offset, st.Size(), func(l []byte) { msgs = append(msgs, parse(l)...) })
	return map[string]any{"messages": msgs, "offset": end}
}

func lastMessages(agent, sessionID string, n int) []message {
	f := transcriptFile(agent, sessionID)
	if f == "" {
		return nil
	}
	msgs, _ := readTranscript(f, agent, 0)["messages"].([]message)
	if n > 0 && len(msgs) > n {
		return msgs[len(msgs)-n:]
	}
	return msgs
}

func formatMessages(msgs []message, agentName string) string {
	lines := make([]string, len(msgs))
	for i, m := range msgs {
		switch m.Role {
		case "user":
			img := ""
			if m.Images > 0 {
				img = fmt.Sprintf(" [%d image(s)]", m.Images)
			}
			lines[i] = "User: " + m.Text + img
		case "assistant":
			lines[i] = agentName + ": " + m.Text
		case "tool":
			lines[i] = "  [" + m.Name + "] " + m.Text
		default:
			lines[i] = "  (" + m.Text + ")"
		}
	}
	return strings.Join(lines, "\n")
}

// Đọc khúc cuối tệp (tối đa win byte), bỏ dòng đầu nếu bị cắt giữa chừng. Trả các dòng đủ và
// vị trí ngay sau '\n' cuối.
func tailLines(file string, size, win int64) ([][]byte, int64, int64) {
	from := size - win
	if from < 0 {
		from = 0
	}
	var lines [][]byte
	end, _ := eachLine(file, from, size, func(l []byte) { lines = append(lines, append([]byte(nil), l...)) })
	if from > 0 && len(lines) > 0 {
		lines = lines[1:]
	}
	return lines, from, end
}

// Tin cuối của agent (hoặc của người dùng) cho danh sách Agents.
func lastAssistantText(agent, sessionID string) string {
	f := transcriptFile(agent, sessionID)
	if f == "" {
		return ""
	}
	st, err := os.Stat(f)
	if err != nil {
		return ""
	}
	// Cả dòng cuối chưa có '\n' cũng tính (JS đọc tới hết tệp): đọc thẳng khúc cuối.
	from := st.Size() - 256*1024
	if from < 0 {
		from = 0
	}
	fh, err := os.Open(f)
	if err != nil {
		return ""
	}
	b := make([]byte, st.Size()-from)
	_, _ = fh.ReadAt(b, from)
	fh.Close()
	lines := bytes.Split(b, []byte{'\n'})
	if from > 0 && len(lines) > 0 {
		lines = lines[1:]
	}
	parse := parserFor(agent)
	for i := len(lines) - 1; i >= 0; i-- {
		var last *message
		for _, m := range parse(lines[i]) {
			if m.Role == "assistant" || m.Role == "user" {
				m := m
				last = &m
			}
		}
		if last != nil {
			prefix := ""
			if last.Role == "user" {
				prefix = "You: "
			}
			return prefix + clip(collapseSpace(last.Text), 180)
		}
	}
	return ""
}

// ─── Sub agent ──────────────────────────────────────────────────────────────
// Claude ghi mỗi sub agent ở <thư mục phiên>/<sessionId>/subagents/agent-<id>.jsonl, kèm
// agent-<id>.meta.json (agentType, description). Đọc nối tiếp theo offset, nhớ theo tệp.

type subState struct {
	offset      int64
	steps       int
	start, last float64
	tool        string
	done        bool
	tokens      float64
	rest        []byte
}

type subagent struct {
	ID          string  `json:"id"`
	Type        string  `json:"type"`
	Description string  `json:"description"`
	Background  bool    `json:"background"`
	State       string  `json:"state"`
	Steps       int     `json:"steps"`
	Tool        string  `json:"tool"`
	Tokens      float64 `json:"tokens"`
	Start       float64 `json:"start"`
	Last        float64 `json:"last"`
}

var (
	subMu    sync.Mutex
	subCache = map[string]*subState{}
)

const subStaleMs = 3 * 60e3

// Tóm tắt input của tool ở dải Sub agent: mô tả trước, rồi lệnh, tệp… Thay thư mục nhà bằng ~.
func subToolBrief(input json.RawMessage) string {
	var m map[string]json.RawMessage
	if json.Unmarshal(input, &m) != nil {
		return ""
	}
	v := ""
	for _, k := range []string{"description", "command", "file_path", "pattern", "path", "url", "query", "prompt"} {
		if s := jsString(m[k]); s != "" {
			v = s
			break
		}
	}
	return strings.Replace(collapseSpace(v), home, "~", 1)
}

// String(v) của JS cho giá trị JSON thường gặp (chuỗi, số, mảng chuỗi); rỗng/false/null → "".
func jsString(r json.RawMessage) string {
	if s, ok := rawString(r); ok {
		return s
	}
	t := bytes.TrimSpace(r)
	if len(t) == 0 || string(t) == "null" || string(t) == "false" || string(t) == "0" {
		return ""
	}
	if t[0] == '[' {
		var arr []json.RawMessage
		if json.Unmarshal(t, &arr) == nil {
			ss := make([]string, len(arr))
			for i, x := range arr {
				ss[i] = jsString(x)
			}
			return strings.Join(ss, ",")
		}
	}
	if t[0] == '{' {
		return "[object Object]"
	}
	return string(t)
}

func readSubagent(file string) subState {
	subMu.Lock()
	defer subMu.Unlock()
	c := subCache[file]
	if c == nil {
		c = &subState{}
		subCache[file] = c
	}
	st, err := os.Stat(file)
	if err != nil {
		return *c
	}
	size := st.Size()
	if size < c.offset {
		*c = subState{}
	}
	if size > c.offset {
		fh, err := os.Open(file)
		if err != nil {
			return *c
		}
		b := make([]byte, size-c.offset)
		_, _ = fh.ReadAt(b, c.offset)
		fh.Close()
		c.offset = size
		data := append(c.rest, b...)
		lines := bytes.Split(data, []byte{'\n'})
		c.rest = append([]byte(nil), lines[len(lines)-1]...)
		for _, l := range lines[:len(lines)-1] {
			var j claudeLine
			if json.Unmarshal(l, &j) != nil {
				continue
			}
			if t := parseTs(j.Timestamp); t != 0 {
				if c.start == 0 {
					c.start = t
				}
				c.last = t
			}
			m := j.Message
			if j.Type != "assistant" || m == nil {
				continue
			}
			if m.Usage != nil {
				c.tokens = m.Usage.total()
			}
			var parts []contentPart
			_ = json.Unmarshal(m.Content, &parts)
			for _, part := range parts {
				if part.Type != "tool_use" {
					continue
				}
				if part.Name == "SubagentHandback" {
					c.done = true
					continue
				}
				c.steps++
				c.tool = jsTrim(part.Name + " " + clip(subToolBrief(part.Input), 80))
			}
			if m.StopReason == "end_turn" {
				c.done = true
			} else if m.StopReason == "tool_use" {
				c.done = false
			}
		}
	}
	return *c
}

var agentFileRe = regexp.MustCompile(`^agent-.+\.jsonl$`)

func subagents(sessionID string) []subagent {
	out := []subagent{}
	main := claudeTranscript(sessionID)
	if main == "" {
		return out
	}
	dir := filepath.Join(strings.TrimSuffix(main, ".jsonl"), "subagents")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	now := nowMs()
	for _, e := range entries {
		n := e.Name()
		if !agentFileRe.MatchString(n) {
			continue
		}
		f := filepath.Join(dir, n)
		var meta struct {
			AgentType    string `json:"agentType"`
			Description  string `json:"description"`
			RequestShape string `json:"requestShape"`
		}
		if b, err := os.ReadFile(strings.TrimSuffix(f, ".jsonl") + ".meta.json"); err == nil {
			_ = json.Unmarshal(b, &meta)
		}
		c := readSubagent(f)
		mtime := c.last
		if st, err := os.Stat(f); err == nil {
			mtime = float64(st.ModTime().UnixMilli())
		}
		state := "stopped"
		if c.done {
			state = "done"
		} else if now-mtime < subStaleMs {
			state = "running"
		}
		typ := meta.AgentType
		if typ == "" {
			typ = "agent"
		}
		last := c.last
		if last == 0 {
			last = mtime
		}
		out = append(out, subagent{
			ID: n[6 : len(n)-6], Type: typ, Description: meta.Description, Background: meta.RequestShape == "background",
			State: state, Steps: c.steps, Tool: c.tool, Tokens: c.tokens, Start: c.start, Last: last,
		})
	}
	sort.SliceStable(out, func(i, k int) bool { return out[i].Start > out[k].Start })
	return out
}

func runningSubs(sessionID string) int {
	n := 0
	for _, s := range subagents(sessionID) {
		if s.State == "running" {
			n++
		}
	}
	return n
}

// ─── Tai thỏ (notch) ────────────────────────────────────────────────────────
// Mỗi phiên agent đang mở: tin gần nhất của người dùng, model, % context. Lần đầu đọc 512 KB
// cuối transcript (thiếu thì 4 MB); các lần poll sau chỉ đọc phần mới ghi thêm.

type tailInfo struct {
	You     *string  `json:"you,omitempty"`
	TurnAt  *float64 `json:"turnAt,omitempty"`
	Model   string   `json:"model,omitempty"`
	CtxUsed *float64 `json:"ctxUsed,omitempty"`
	CtxMax  *float64 `json:"ctxMax,omitempty"`
	LastAt  float64  `json:"lastAt,omitempty"`
	// Prompt cache (chỉ Claude): request cuối gửi lúc CacheAt, cache sống CacheTTL giây kể từ đó.
	// Compacted = đã /compact sau request cuối — cache cũ không còn dùng tới, khỏi đếm.
	CacheAt   *float64 `json:"cacheAt,omitempty"`
	CacheTTL  float64  `json:"cacheTtl,omitempty"`
	Compacted bool     `json:"compacted,omitempty"`
	userAt    float64  // dòng user mới nhất đã đọc — cho lần đọc nối sau
}

// ─── Prompt cache ───────────────────────────────────────────────────────────
// Cache được làm mới khi request tới API, tức ngay sau dòng user (prompt / tool_result) đứng
// trước phản hồi. Lấy giờ dòng user đó chứ không lấy giờ phản hồi: phản hồi dài viết xong sau
// vài phút, tính theo nó thì báo trễ.

type cacheScan struct {
	userAt, assistAt, reqAt, ttl float64
	compacted                    bool
}

func scanCache(lines [][]byte) cacheScan {
	var c cacheScan
	for i := len(lines) - 1; i >= 0; i-- {
		var j claudeLine
		if json.Unmarshal(lines[i], &j) != nil || j.IsSidechain {
			continue
		}
		ts := parseTs(j.Timestamp)
		switch {
		case c.assistAt == 0 && (j.IsCompactSummary || j.Type == "system" && j.Subtype == "compact_boundary"):
			c.compacted = true
		case j.Type == "assistant" && j.Message != nil && j.Message.Usage != nil && j.Message.Model != "<synthetic>":
			if c.assistAt == 0 {
				c.assistAt = ts
			}
			if c.ttl == 0 {
				c.ttl = j.Message.Usage.ttl()
			}
		case j.Type == "user":
			if c.userAt == 0 {
				c.userAt = ts
			}
			if c.assistAt != 0 && c.reqAt == 0 {
				c.reqAt = ts
			}
		}
		if c.compacted || c.reqAt != 0 && c.ttl != 0 {
			break
		}
	}
	return c
}

// Ghép kết quả quét vào info. `prevUser` = dòng user mới nhất của lần đọc trước (đoạn mới có
// thể chỉ chứa phản hồi, còn prompt nằm ở đoạn cũ).
func applyCache(info *tailInfo, c cacheScan, prevUser float64) {
	if c.userAt != 0 {
		info.userAt = c.userAt
	}
	if c.ttl != 0 {
		info.CacheTTL = c.ttl
	}
	if c.compacted {
		info.Compacted, info.CacheAt = true, nil
		return
	}
	if c.assistAt == 0 {
		return
	}
	at := c.reqAt
	if at == 0 {
		at = c.assistAt
		if prevUser != 0 && prevUser <= c.assistAt {
			at = prevUser
		}
	}
	info.Compacted, info.CacheAt = false, f64(at)
}

var (
	tailMu    sync.Mutex
	tailCache = map[string]struct {
		size int64
		info tailInfo
	}{}
	modelRe = regexp.MustCompile(`^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$`)
)

func prettyModel(m string) string {
	x := modelRe.FindStringSubmatch(m)
	if x == nil {
		return m
	}
	s := strings.ToUpper(x[1][:1]) + x[1][1:] + " " + x[2]
	if x[3] != "" {
		s += "." + x[3]
	}
	return s
}

func f64(v float64) *float64 { return &v }

// Duyệt từ dòng mới nhất ngược lên, chỉ điền trường còn thiếu.
func scanTail(agent string, lines [][]byte) tailInfo {
	var info tailInfo
	done := func() bool { return info.You != nil && info.Model != "" && info.CtxUsed != nil }
	for i := len(lines) - 1; i >= 0 && !done(); i-- {
		var msgs []message
		if agent == "claude" {
			var j claudeLine
			if json.Unmarshal(lines[i], &j) != nil || j.IsSidechain {
				continue
			}
			if m := j.Message; j.Type == "assistant" && m != nil && m.Model != "" && m.Model != "<synthetic>" {
				if info.Model == "" {
					info.Model = prettyModel(m.Model)
				}
				if m.Usage != nil && info.CtxUsed == nil {
					info.CtxUsed = f64(m.Usage.total())
				}
			}
			if info.You == nil {
				msgs = claudeMessages(&j)
			}
		} else {
			var j codexLine
			if json.Unmarshal(lines[i], &j) != nil {
				continue
			}
			if p := j.Payload; p != nil {
				if j.Type == "turn_context" && p.Model != "" && info.Model == "" {
					info.Model = p.Model
				}
				if j.Type == "event_msg" && p.Type == "token_count" && p.Info != nil && info.CtxUsed == nil {
					used := 0.0
					if p.Info.Last != nil && p.Info.Last.Total != nil {
						used = *p.Info.Last.Total
					}
					info.CtxUsed = f64(used)
					info.CtxMax = nil
					if p.Info.Window != 0 {
						info.CtxMax = f64(p.Info.Window)
					}
				}
			}
			if info.You == nil {
				msgs = codexMessages(&j)
			}
		}
		for _, u := range msgs {
			if u.Role != "user" {
				continue
			}
			t := jsTrim(collapseSpace(u.Text))
			if t == "" {
				t = fmt.Sprintf("[%d image(s)]", u.Images)
			}
			you := clip(t, 160)
			info.You, info.TurnAt = &you, f64(u.Ts)
			break
		}
	}
	return info
}

func transcriptTail(agent, sessionID string) tailInfo {
	f := transcriptFile(agent, sessionID)
	if f == "" {
		return tailInfo{}
	}
	st, err := os.Stat(f)
	if err != nil {
		return tailInfo{}
	}
	mtime := float64(st.ModTime().UnixMilli())
	tailMu.Lock()
	hit, ok := tailCache[f]
	tailMu.Unlock()
	if ok && hit.size == st.Size() {
		info := hit.info
		info.LastAt = mtime
		return info
	}
	var info tailInfo
	var size int64
	if ok && st.Size() > hit.size {
		// Chỉ phần mới; dòng cuối có thể đang ghi dở nên dừng ở '\n' cuối cùng.
		var lines [][]byte
		end, _ := eachLine(f, hit.size, st.Size(), func(l []byte) { lines = append(lines, append([]byte(nil), l...)) })
		size = end
		fresh := scanTail(agent, lines)
		info = hit.info
		if agent == "claude" {
			applyCache(&info, scanCache(lines), hit.info.userAt)
		}
		if fresh.You != nil {
			info.You, info.TurnAt = fresh.You, fresh.TurnAt
		}
		if fresh.Model != "" {
			info.Model = fresh.Model
		}
		if fresh.CtxUsed != nil {
			info.CtxUsed = fresh.CtxUsed
			if agent == "claude" {
				info.CtxMax = nil
			} else if fresh.CtxMax != nil {
				info.CtxMax = fresh.CtxMax
			}
		}
	} else {
		for _, win := range []int64{512 * 1024, 4 * 1024 * 1024} {
			lines, from, end := tailLines(f, st.Size(), win)
			size = end
			info = scanTail(agent, lines)
			if agent == "claude" {
				applyCache(&info, scanCache(lines), 0)
			}
			if info.You != nil || from == 0 {
				break
			}
		}
	}
	// Claude không ghi cỡ context vào transcript: 200k, vượt thì là bản 1M.
	if info.CtxUsed != nil && info.CtxMax == nil {
		if *info.CtxUsed > 200e3 {
			info.CtxMax = f64(1e6)
		} else {
			info.CtxMax = f64(200e3)
		}
	}
	info.LastAt = 0
	tailMu.Lock()
	tailCache[f] = struct {
		size int64
		info tailInfo
	}{size, info}
	tailMu.Unlock()
	info.LastAt = mtime
	return info
}

// ─── Danh sách Agents / tai thỏ ─────────────────────────────────────────────
// JS gửi các node terminal (đã ghép tên project / canvas), Go điền phần trạng thái và transcript.

type nodeRef struct {
	NodeID    string `json:"nodeId"`
	Agent     string `json:"agent"`
	SessionID string `json:"sessionId"`
}

func agentsInfo(list []nodeRef) map[string]any {
	out := map[string]any{}
	for _, n := range list {
		sid := liveSessionID(n.NodeID, n.SessionID)
		x := map[string]any{"status": status(n.NodeID), "last": "", "subs": 0}
		if n.Agent != "shell" {
			x["last"] = lastAssistantText(n.Agent, sid)
		}
		if n.Agent == "claude" {
			x["subs"] = runningSubs(sid)
		}
		out[n.NodeID] = x
	}
	return out
}

// Chỉ node có phiên đang sống; node khác không có trong kết quả.
func notchInfo(list []nodeRef) map[string]any {
	out := map[string]any{}
	for _, n := range list {
		s := getSession(n.NodeID)
		if s == nil || n.Agent == "shell" {
			continue
		}
		sid := liveSessionID(n.NodeID, n.SessionID)
		t := transcriptTail(n.Agent, sid)
		subs := 0
		if n.Agent == "claude" {
			subs = runningSubs(sid)
		}
		out[n.NodeID] = map[string]any{"status": status(n.NodeID), "startedAt": s.startedAt, "tail": t, "subs": subs}
	}
	return out
}
