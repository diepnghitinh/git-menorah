package main

// Kiểm các hàm nhỏ chép từ bản JS: kết quả phải giống hệt JS (giá trị mong đợi lấy từ node).
// Chạy: cd agentd && GOTOOLCHAIN=local go test ./...

import (
	"reflect"
	"strings"
	"testing"
)

func TestCpuSeconds(t *testing.T) {
	for in, want := range map[string]float64{
		"3.45":          3.45,
		"02:03.45":      123.45,
		"1:02:03.5":     3723.5,
		"1-02:03:04.56": 86400 + 7384.56,
	} {
		if got := cpuSeconds(in); got-want > 1e-9 || want-got > 1e-9 {
			t.Errorf("cpuSeconds(%q) = %v, muốn %v", in, got, want)
		}
	}
}

func TestSplitArgs(t *testing.T) {
	for in, want := range map[string][]string{
		"":                               {},
		"list":                           {"list"},
		"summary --node 'Nhà gà 1' -n 5": {"summary", "--node", "Nhà gà 1", "-n", "5"},
		`terminal --node="a b"`:          {"terminal", "--node=a b"},
		`x "" y`:                         {"x", "", "y"},
	} {
		if got := splitArgs(in); !reflect.DeepEqual(got, want) {
			t.Errorf("splitArgs(%q) = %q, muốn %q", in, got, want)
		}
	}
}

func TestPlainText(t *testing.T) {
	// node: plainText('\x1b[31mđỏ\x1b[0m\r\nab\rxy\n\n\n\x1b]0;title\x07z  ')
	got := plainText("\x1b[31mđỏ\x1b[0m\r\nab\rxy\n\n\n\x1b]0;title\x07z  ")
	if want := "đỏ\nxy\n\nz"; got != want {
		t.Errorf("plainText = %q, muốn %q", got, want)
	}
}

func TestClip(t *testing.T) {
	if got := clip("abcdef", 4); got != "abc…" {
		t.Errorf("clip ascii = %q", got)
	}
	if got := clip("gà con", 10); got != "gà con" {
		t.Errorf("clip ngắn = %q", got)
	}
	// "😀" là 2 đơn vị UTF-16: không cắt đôi.
	if got := clip("ab😀cd", 4); got != "ab…" {
		t.Errorf("clip emoji = %q", got)
	}
}

func TestPrettyModel(t *testing.T) {
	for in, want := range map[string]string{
		"claude-opus-4-5-20251101": "Opus 4.5",
		"claude-sonnet-4-20250514": "Sonnet 4",
		"claude-fable-5-1":         "Fable 5.1",
		"gpt-5-codex":              "gpt-5-codex",
	} {
		if got := prettyModel(in); got != want {
			t.Errorf("prettyModel(%q) = %q, muốn %q", in, got, want)
		}
	}
}

func TestJsStringify(t *testing.T) {
	for in, want := range map[string]string{
		`{ "b": 1, "a": [true, null, 1.50] }`: `{"b":1,"a":[true,null,1.5]}`,
		`{"s":"gà é \"x\" \n"}`:               `{"s":"gà é \"x\" \n"}`,
		`"<tag>&"`:                            `"<tag>&"`,
		`[1e2, 1e-7, 1e21, 0.000001, -0, 12345678901234567890]`: `[100,1e-7,1e+21,0.000001,0,12345678901234567000]`,
	} {
		got, ok := jsStringify([]byte(in))
		if !ok || got != want {
			t.Errorf("jsStringify(%s) = %s (%v), muốn %s", in, got, ok, want)
		}
	}
	if _, ok := jsStringify([]byte(`{"a":`)); ok {
		t.Error("jsStringify nhận JSON hỏng")
	}
}

func TestJsParseInt(t *testing.T) {
	for in, want := range map[string]int{"15": 15, " 7x": 7, "abc": 0, "-3": -3} {
		if got := jsParseInt(in); got != want {
			t.Errorf("jsParseInt(%q) = %d, muốn %d", in, got, want)
		}
	}
}

func TestSplitUTF8KeepTail(t *testing.T) {
	b := []byte("gà")
	whole, rest := splitUTF8(b[:len(b)-1])
	if string(whole) != "g" || len(rest) != 1 {
		t.Errorf("splitUTF8 = %q / %q", whole, rest)
	}
	if got := string(keepTail([]byte("xàyz"), 4)); !strings.HasSuffix("xàyz", got) || got != "yz" && got != "àyz" {
		t.Errorf("keepTail = %q", got)
	}
}

func TestContextGraph(t *testing.T) {
	setCanvas("c1", []ctxNode{
		{ID: "n1", Kind: "terminal", Agent: "claude", Title: "Agent A"},
		{ID: "n2", Kind: "note", Title: "Ghi chú", Text: "nội dung"},
		{ID: "n3", Kind: "terminal", Agent: "shell", Title: "Shell"},
	}, []ctxLink{{From: "n1", To: "n2"}})
	defer dropCanvas("c1")
	if got := contextCommand("n1", splitArgs("list")); got != "n2\tnote\tGhi chú" {
		t.Errorf("list = %q", got)
	}
	if got := contextCommand("n1", splitArgs("summary --node ghi")); got != "nội dung" {
		t.Errorf("summary note = %q", got)
	}
	if got := contextCommand("n3", nil); !strings.HasPrefix(got, "Not linked") {
		t.Errorf("list rỗng = %q", got)
	}
	if got := contextCommand("x", nil); !strings.HasPrefix(got, "Not a GitMenorah") {
		t.Errorf("node lạ = %q", got)
	}
}

func TestScanCache(t *testing.T) {
	line := func(s string) []byte { return []byte(s) }
	user := func(ts string) []byte {
		return line(`{"type":"user","timestamp":"` + ts + `","message":{"content":"hi"}}`)
	}
	asst := func(ts, cc string) []byte {
		return line(`{"type":"assistant","timestamp":"` + ts + `","message":{"model":"claude-opus-5-5","usage":{"input_tokens":1,"cache_creation":` + cc + `}}}`)
	}
	h1, m5, none := `{"ephemeral_1h_input_tokens":10,"ephemeral_5m_input_tokens":0}`, `{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":7}`, `{}`
	ms := func(ts string) float64 { return parseTs(ts) }

	// Request gửi lúc dòng user trước phản hồi, không phải lúc phản hồi viết xong; TTL lấy từ
	// request gần nhất có ghi cache.
	var info tailInfo
	applyCache(&info, scanCache([][]byte{
		user("2026-10-22T10:00:00Z"), asst("2026-10-22T10:00:05Z", m5),
		user("2026-10-22T10:01:00Z"), asst("2026-10-22T10:03:00Z", none), asst("2026-10-22T10:03:10Z", none),
	}), 0)
	if info.CacheAt == nil || *info.CacheAt != ms("2026-10-22T10:01:00Z") || info.CacheTTL != 300 || info.Compacted {
		t.Errorf("full scan: cacheAt=%v ttl=%v compacted=%v", info.CacheAt, info.CacheTTL, info.Compacted)
	}

	// Đọc nối: đoạn mới chỉ có phản hồi → lấy dòng user của lần đọc trước.
	applyCache(&info, scanCache([][]byte{user("2026-10-22T11:00:00Z")}), info.userAt)
	applyCache(&info, scanCache([][]byte{asst("2026-10-22T11:02:00Z", h1)}), info.userAt)
	if *info.CacheAt != ms("2026-10-22T11:00:00Z") || info.CacheTTL != 3600 {
		t.Errorf("incremental: cacheAt=%v ttl=%v", *info.CacheAt, info.CacheTTL)
	}

	// /compact sau phản hồi cuối → khỏi đếm; prompt mới sau compact thì đếm lại.
	applyCache(&info, scanCache([][]byte{
		line(`{"type":"system","subtype":"compact_boundary","timestamp":"2026-10-22T11:10:00Z"}`),
		line(`{"type":"user","isCompactSummary":true,"timestamp":"2026-10-22T11:10:01Z","message":{"content":"sum"}}`),
		user("2026-10-22T11:10:02Z"),
	}), info.userAt)
	if !info.Compacted || info.CacheAt != nil {
		t.Errorf("compact: compacted=%v cacheAt=%v", info.Compacted, info.CacheAt)
	}
	applyCache(&info, scanCache([][]byte{user("2026-10-22T11:20:00Z"), asst("2026-10-22T11:20:09Z", h1)}), info.userAt)
	if info.Compacted || info.CacheAt == nil || *info.CacheAt != ms("2026-10-22T11:20:00Z") {
		t.Errorf("after compact: compacted=%v cacheAt=%v", info.Compacted, info.CacheAt)
	}

	// Sub agent (sidechain) và phản hồi <synthetic> không làm mới cache của phiên chính.
	c := scanCache([][]byte{
		user("2026-10-22T12:00:00Z"), asst("2026-10-22T12:00:03Z", h1),
		line(`{"type":"assistant","isSidechain":true,"timestamp":"2026-10-22T12:30:00Z","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":1}}}`),
		line(`{"type":"assistant","timestamp":"2026-10-22T12:31:00Z","message":{"model":"<synthetic>","usage":{"input_tokens":0}}}`),
	})
	if c.reqAt != ms("2026-10-22T12:00:00Z") {
		t.Errorf("sidechain/synthetic: reqAt=%v", c.reqAt)
	}
}

func TestHasLocale(t *testing.T) {
	if hasLocale([]string{"HOME=/x", "LANG="}) {
		t.Error("empty LANG counts as no locale")
	}
	for _, kv := range []string{"LANG=vi_VN.UTF-8", "LC_ALL=en_US.UTF-8", "LC_CTYPE=UTF-8"} {
		if !hasLocale([]string{"HOME=/x", kv}) {
			t.Errorf("%s should count as a locale", kv)
		}
	}
}
