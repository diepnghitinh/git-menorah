package main

// Tiện ích chữ theo đúng nghĩa JS mà backend.cjs từng dùng: độ dài tính theo UTF-16, \s gồm cả
// khoảng trắng Unicode, Date.parse cho ISO 8601.

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

func nowMs() float64 { return float64(time.Now().UnixMilli()) }

// Như /\s/ của JS.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// s.replace(/\s+/g, ' ')
func collapseSpace(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	in := false
	for _, r := range s {
		if isJSSpace(r) {
			if !in {
				b.WriteByte(' ')
			}
			in = true
			continue
		}
		in = false
		b.WriteRune(r)
	}
	return b.String()
}

func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// Độ dài kiểu JS (số đơn vị UTF-16).
func jsLen(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// clip(s, n): quá n đơn vị UTF-16 thì cắt còn n-1 rồi thêm "…". Không cắt đôi ký tự 4 byte
// (JS cắt đôi, để lại nửa cặp surrogate — ở đây bỏ hẳn ký tự đó).
func clip(s string, n int) string {
	if jsLen(s) <= n {
		return s
	}
	units := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units+w > n-1 {
			return s[:i] + "…"
		}
		units += w
	}
	return s
}

// Date.parse cho dấu thời gian ISO trong transcript; không đọc được thì 0.
func parseTs(s string) float64 {
	if s == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0
	}
	return float64(t.UnixMilli())
}

// Bỏ phần đuôi là ký tự UTF-8 chưa đủ byte; trả phần đủ và phần dư để ghép lần sau.
func splitUTF8(b []byte) (whole, rest []byte) {
	n := len(b)
	for i := 1; i <= 3 && i <= n; i++ {
		c := b[n-i]
		if c < 0x80 {
			return b, nil
		}
		if c >= 0xc0 { // byte đầu của một ký tự
			need := 2
			if c >= 0xf0 {
				need = 4
			} else if c >= 0xe0 {
				need = 3
			}
			if i < need {
				return b[:n-i], b[n-i:]
			}
			return b, nil
		}
	}
	return b, nil
}

// Cắt đầu b cho còn tối đa max byte, không bắt đầu giữa một ký tự.
func keepTail(b []byte, max int) []byte {
	if len(b) <= max {
		return b
	}
	b = b[len(b)-max:]
	for len(b) > 0 && !utf8.RuneStart(b[0]) {
		b = b[1:]
	}
	return b
}

// JSON.stringify(JSON.parse(raw)): gọn, giữ thứ tự khoá, chuỗi viết lại theo kiểu JS (chữ có dấu
// in thẳng, không \u00e9).
func jsStringify(raw []byte) (string, bool) {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var b strings.Builder
	var walk func() bool
	walk = func() bool {
		tok, err := d.Token()
		if err != nil {
			return false
		}
		switch x := tok.(type) {
		case json.Delim:
			if x == '{' {
				b.WriteByte('{')
				for i := 0; d.More(); i++ {
					if i > 0 {
						b.WriteByte(',')
					}
					k, err := d.Token()
					if err != nil {
						return false
					}
					b.WriteString(jsQuote(k.(string)))
					b.WriteByte(':')
					if !walk() {
						return false
					}
				}
				_, err = d.Token()
				b.WriteByte('}')
				return err == nil
			}
			b.WriteByte('[')
			for i := 0; d.More(); i++ {
				if i > 0 {
					b.WriteByte(',')
				}
				if !walk() {
					return false
				}
			}
			_, err = d.Token()
			b.WriteByte(']')
			return err == nil
		case string:
			b.WriteString(jsQuote(x))
		case json.Number:
			b.WriteString(jsNumber(x))
		case bool:
			if x {
				b.WriteString("true")
			} else {
				b.WriteString("false")
			}
		case nil:
			b.WriteString("null")
		}
		return true
	}
	if !walk() {
		return "", false
	}
	return b.String(), true
}

// Số theo cách JS in: 1.50 → 1.5, 1e2 → 100, 1e-7 → 1e-7, 1e21 → 1e+21.
func jsNumber(n json.Number) string {
	f, err := strconv.ParseFloat(string(n), 64)
	if err != nil {
		return string(n)
	}
	if f == 0 {
		return "0" // -0 cũng in "0"
	}
	if a := math.Abs(f); a >= 1e-6 && a < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	s := strconv.FormatFloat(f, 'e', -1, 64) // 1e-07 → JS 1e-7
	if i := strings.IndexByte(s, 'e'); i >= 0 {
		exp := strings.TrimLeft(s[i+2:], "0")
		s = s[:i+2] + exp
	}
	return s
}

func jsQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			if r < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte("0123456789abcdef"[r>>4])
				b.WriteByte("0123456789abcdef"[r&15])
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
