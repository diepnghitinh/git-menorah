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
