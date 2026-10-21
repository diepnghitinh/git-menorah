package main

// Cổng context (menorah-context). Chỉ nghe 127.0.0.1, mọi request phải có token của lần chạy
// app. Node chỉ đọc được node nối dây với mình (và ghi chú nối với mình).
//
// Canvas do JS lưu; mỗi lần mở / lưu / xoá canvas JS gửi sơ đồ sang bằng op "canvas".

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

type ctxNode struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Agent     string `json:"agent"`
	Title     string `json:"title"`
	Text      string `json:"text"`
	Path      string `json:"path"`
	Cwd       string `json:"cwd"`
	SessionID string `json:"sessionId"`
}

type ctxLink struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type canvasGraph struct {
	nodes []ctxNode
	links []ctxLink
}

var (
	graphMu sync.RWMutex
	graphs  = map[string]canvasGraph{} // canvasId → sơ đồ
	// Thứ tự canvas như JS gửi lần đầu — tìm node trùng id thì lấy canvas đến trước, như allNodes().
	graphOrder []string
)

func setCanvas(id string, nodes []ctxNode, links []ctxLink) {
	graphMu.Lock()
	defer graphMu.Unlock()
	if _, ok := graphs[id]; !ok {
		graphOrder = append(graphOrder, id)
	}
	graphs[id] = canvasGraph{nodes, links}
}

func dropCanvas(id string) {
	graphMu.Lock()
	defer graphMu.Unlock()
	delete(graphs, id)
	for i, x := range graphOrder {
		if x == id {
			graphOrder = append(graphOrder[:i], graphOrder[i+1:]...)
			break
		}
	}
}

func linkedOf(selfID string) (*ctxNode, []ctxNode) {
	graphMu.RLock()
	defer graphMu.RUnlock()
	for _, cid := range graphOrder {
		g := graphs[cid]
		for i := range g.nodes {
			if g.nodes[i].ID != selfID {
				continue
			}
			ids := map[string]bool{}
			for _, l := range g.links {
				if l.From == selfID {
					ids[l.To] = true
				} else if l.To == selfID {
					ids[l.From] = true
				}
			}
			var linked []ctxNode
			for _, n := range g.nodes {
				if ids[n.ID] {
					linked = append(linked, n)
				}
			}
			self := g.nodes[i]
			return &self, linked
		}
	}
	return nil, nil
}

// Tách tham số kiểu shell đơn giản: nháy đơn / kép, khoảng trắng.
func splitArgs(s string) []string {
	out := []string{}
	var cur strings.Builder
	var q rune
	has := false
	for _, ch := range s {
		if q != 0 {
			if ch == q {
				q = 0
			} else {
				cur.WriteRune(ch)
			}
			continue
		}
		if ch == '"' || ch == '\'' {
			q, has = ch, true
			continue
		}
		if isJSSpace(ch) {
			if cur.Len() > 0 || has {
				out = append(out, cur.String())
			}
			cur.Reset()
			has = false
			continue
		}
		cur.WriteRune(ch)
	}
	if cur.Len() > 0 || has {
		out = append(out, cur.String())
	}
	return out
}

var (
	oscRe  = regexp.MustCompile(`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`)
	csiRe  = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
	escRe  = regexp.MustCompile(`\x1b[@-Z\\-_]`)
	ctrlRe = regexp.MustCompile(`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`)
)

// Bỏ mã ANSI và áp \r để đọc được output terminal dạng chữ. TUI vẽ lại bằng con trỏ nên kết quả
// chỉ gần đúng — agent nên đọc `summary`/`transcript` trước.
func plainText(raw string) string {
	s := oscRe.ReplaceAllString(raw, "")
	s = csiRe.ReplaceAllString(s, "")
	s = escRe.ReplaceAllString(s, "")
	s = ctrlRe.ReplaceAllString(s, "")
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		// lastIndexOf('\r', length-2): bỏ qua \r ở cuối dòng
		if len(l) >= 2 {
			if j := strings.LastIndexByte(l[:len(l)-1], '\r'); j >= 0 {
				l = l[j+1:]
			}
		}
		lines[i] = strings.TrimRightFunc(strings.TrimSuffix(l, "\r"), isJSSpace)
	}
	out := make([]string, 0, len(lines))
	for i, l := range lines {
		prev := ""
		if i > 0 {
			prev = lines[i-1]
		}
		if l != "" || (i > 0 && prev != "") {
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
}

func lastLines(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

var agentName = map[string]string{"claude": "Claude", "codex": "Codex", "shell": "Terminal"}

func kindLabel(n ctxNode) string {
	if n.Kind == "note" || n.Kind == "image" {
		return n.Kind
	}
	return n.Agent
}

func listLinked(linked []ctxNode) string {
	rows := make([]string, len(linked))
	for i, x := range linked {
		rows[i] = x.ID + "\t" + kindLabel(x) + "\t" + x.Title
	}
	return strings.Join(rows, "\n")
}

func contextCommand(selfID string, argv []string) string {
	cmd := "list"
	var rest []string
	if len(argv) > 0 {
		cmd, rest = argv[0], argv[1:]
	}
	target, n := "", 15
	for i := 0; i < len(rest); i++ {
		switch {
		case rest[i] == "--node":
			i++
			if i < len(rest) {
				target = rest[i]
			}
		case strings.HasPrefix(rest[i], "--node="):
			target = rest[i][7:]
		case rest[i] == "-n":
			i++
			v := 0
			if i < len(rest) {
				v = jsParseInt(rest[i])
			}
			if v == 0 {
				v = 15
			}
			n = max(1, v)
		}
	}
	self, linked := linkedOf(selfID)
	if self == nil {
		return "Not a GitMenorah session (MENORAH_NODE_ID missing, or the node was deleted)."
	}
	if cmd == "list" {
		if len(linked) == 0 {
			return "Not linked to any node. On the canvas, drag the link dot in this node's title bar onto another node."
		}
		return listLinked(linked)
	}
	if cmd != "summary" && cmd != "transcript" && cmd != "terminal" {
		return "Unknown command: " + cmd + ". Usage: list | summary [--node X] [-n 15] | transcript [--node X] | terminal [--node X]"
	}
	var node *ctxNode
	if target != "" {
		t := strings.ToLower(target)
		for _, match := range []func(x ctxNode) bool{
			func(x ctxNode) bool { return x.ID == target },
			func(x ctxNode) bool { return strings.ToLower(x.Title) == t },
			func(x ctxNode) bool { return strings.Contains(strings.ToLower(x.Title), t) },
		} {
			for i := range linked {
				if match(linked[i]) {
					node = &linked[i]
					break
				}
			}
			if node != nil {
				break
			}
		}
	} else if len(linked) == 1 {
		node = &linked[0]
	}
	if node == nil {
		if len(linked) > 0 {
			return "Specify --node (id or title). Linked to:\n" + listLinked(linked)
		}
		return "Not linked to any node."
	}
	if node.Kind == "note" {
		if node.Text == "" {
			return "(empty note)"
		}
		return node.Text
	}
	if node.Kind == "image" {
		return "Image: " + node.Path
	}
	buf, live := sessionBuffer(node.ID)
	if cmd == "terminal" || node.Agent == "shell" {
		if !live {
			return "(terminal stopped)"
		}
		keep := 200
		if cmd == "terminal" {
			keep = max(n, 200)
		}
		return lastLines(plainText(buf), keep)
	}
	k := 0
	if cmd == "summary" {
		k = n
	}
	msgs := lastMessages(node.Agent, liveSessionID(node.ID, node.SessionID), k)
	if len(msgs) == 0 {
		return "(no conversation yet)"
	}
	title := node.Title
	if title == "" {
		title = node.ID
	}
	return "# " + agentName[node.Agent] + " · " + title + " · " + node.Cwd + "\n" + formatMessages(msgs, agentName[node.Agent])
}

// parseInt(x, 10) của JS: lấy phần số ở đầu chuỗi; không có số → 0 (JS là NaN, rồi || 15).
func jsParseInt(s string) int {
	s = jsTrim(s)
	end := 0
	if end < len(s) && (s[end] == '-' || s[end] == '+') {
		end++
	}
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	v, _ := strconv.Atoi(s[:end])
	return v
}

func startContextServer() (map[string]string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	ctxToken = hex.EncodeToString(b)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	ctxURL = fmt.Sprintf("http://127.0.0.1:%d", ln.Addr().(*net.TCPAddr).Port)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		send := func(code int, txt string) {
			w.Header().Set("content-type", "text/plain; charset=utf-8")
			w.WriteHeader(code)
			_, _ = w.Write([]byte(txt + "\n"))
		}
		if r.Header.Get("x-menorah-token") != ctxToken {
			send(403, "Bad token.")
			return
		}
		if r.URL.Path != "/ctx" {
			send(404, "Not found.")
			return
		}
		defer func() {
			if p := recover(); p != nil {
				send(500, fmt.Sprintf("Error: %v", p))
			}
		}()
		q := r.URL.Query()
		send(200, contextCommand(q.Get("self"), splitArgs(q.Get("args"))))
	})}
	go func() { _ = srv.Serve(ln) }()
	return map[string]string{"url": ctxURL, "token": ctxToken}, nil
}
