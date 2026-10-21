package main

// Giới hạn CPU / RAM chung cho mọi terminal của GitMenorah (node trên canvas + khay Terminal tab Git).
//
// macOS không có cgroups, nên không khoá cứng được cả nhóm tiến trình. Thay vào đó mỗi giây đọc
// `ps` một lần, cộng CPU (độ chênh thời gian CPU) và RSS của cả cây tiến trình dưới mỗi phiên:
//   - CPU vượt: hãm kiểu cpulimit — xen kẽ SIGSTOP / SIGCONT các cây con trong chu kỳ 100ms.
//   - RAM vượt: tắt tiến trình con ăn RAM nhiều nhất (SIGTERM, 3 giây sau SIGKILL), rồi báo.
//
// Không bao giờ đụng shell của phiên, agent (con trực tiếp của shell) và con của một shell được
// bảo vệ: shell tương tác thấy con trực tiếp của nó bị dừng sẽ in "suspended" và giành lại bàn
// phím. Cây con của build/test (vd. claude → zsh -c → tsc) thì dừng từ trên xuống, chạy lại từ
// dưới lên, nên shell -c ở giữa không kịp thấy con mình dừng.
// Windows không có SIGSTOP: chỉ đo, không hãm, không tắt.

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var limitsSupported = runtime.GOOS != "windows"

const (
	tickEvery      = time.Second
	dutyPeriod     = 100 * time.Millisecond
	minDuty        = 0.05
	killCooldownMs = 5000
)

var shellNameRe = regexp.MustCompile(`^(ba|z|da|k|tc|c|fi|mk|)sh$`)

type limits struct {
	CPU   float64 `json:"cpu"`   // số nhân; 0 = không giới hạn
	RAMMb float64 `json:"ramMb"` // 0 = không giới hạn
}

type usageInfo struct {
	CPU   float64 `json:"cpu"`
	RAMMb float64 `json:"ramMb"`
	Procs int     `json:"procs"`
	Duty  float64 `json:"duty"`
	At    float64 `json:"at"`
}

type proc struct {
	pid, ppid int
	rssKb     float64
	cpu       float64
	name      string
}

// "1-02:03:04.56" | "02:03.45" | "3.45" → giây.
func cpuSeconds(t string) float64 {
	d, rest := "0", t
	if i := strings.IndexByte(t, '-'); i >= 0 {
		d, rest = t[:i], t[i+1:]
	}
	acc := 0.0
	for _, x := range strings.Split(rest, ":") {
		v, _ := strconv.ParseFloat(x, 64)
		acc = acc*60 + v
	}
	days, _ := strconv.ParseFloat(d, 64)
	return acc + days*86400
}

var psLineRe = regexp.MustCompile(`^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$`)

func readPs() map[int]*proc {
	out, err := exec.Command("ps", "-A", "-o", "pid=,ppid=,rss=,time=,comm=").Output()
	if err != nil {
		return nil
	}
	procs := map[int]*proc{}
	for _, line := range strings.Split(string(out), "\n") {
		m := psLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		pid, _ := strconv.Atoi(m[1])
		ppid, _ := strconv.Atoi(m[2])
		rss, _ := strconv.ParseFloat(m[3], 64)
		procs[pid] = &proc{pid: pid, ppid: ppid, rssKb: rss, cpu: cpuSeconds(m[4]), name: strings.TrimPrefix(filepath.Base(strings.TrimSpace(m[5])), "-")}
	}
	return procs
}

type limiterT struct {
	mu        sync.Mutex
	lim       limits
	usage     usageInfo
	prev      map[int]float64 // pid → giây CPU lần đo trước
	prevAt    float64
	duty      float64 // phần thời gian cây con được chạy
	groups    [][]int // cây con bị hãm, mỗi cây từ trên xuống
	stopped   bool    // đang ở pha dừng của chu kỳ
	lastKill  float64
	lastWarn  float64
	watchTill float64 // màn Settings đang mở: vẫn đo dù chưa đặt giới hạn
	quit      chan struct{}
	running   bool
}

var limiter *limiterT

func newLimiter() *limiterT {
	return &limiterT{duty: 1, prev: map[int]float64{}, quit: make(chan struct{})}
}

func (l *limiterT) resumeAll() {
	for _, g := range l.groups {
		for i := len(g) - 1; i >= 0; i-- {
			signalCont(g[i])
		}
	}
	l.stopped = false
}

func (l *limiterT) pauseAll() {
	for _, g := range l.groups {
		for _, pid := range g {
			signalStop(pid)
		}
	}
	l.stopped = true
}

func (l *limiterT) start() {
	l.mu.Lock()
	if l.running {
		l.mu.Unlock()
		return
	}
	l.running = true
	l.mu.Unlock()
	go func() {
		t := time.NewTicker(tickEvery)
		defer t.Stop()
		for {
			l.measure()
			select {
			case <-l.quit:
				return
			case <-t.C:
			}
		}
	}()
	go l.cycle()
}

// Chu kỳ hãm: chạy duty×100ms, dừng phần còn lại. Không hãm thì ngủ chờ.
func (l *limiterT) cycle() {
	for {
		l.mu.Lock()
		d, active := l.duty, l.duty < 1 && len(l.groups) > 0
		if !active && l.stopped {
			l.resumeAll()
		}
		if active {
			l.resumeAll()
		}
		l.mu.Unlock()
		if !active {
			if l.sleep(dutyPeriod) {
				return
			}
			continue
		}
		if l.sleep(time.Duration(float64(dutyPeriod) * d)) {
			return
		}
		l.mu.Lock()
		if l.duty < 1 {
			l.pauseAll()
		}
		d = l.duty
		l.mu.Unlock()
		if l.sleep(time.Duration(float64(dutyPeriod) * (1 - d))) {
			return
		}
	}
}

func (l *limiterT) sleep(d time.Duration) bool {
	select {
	case <-l.quit:
		return true
	case <-time.After(d):
		return false
	}
}

func (l *limiterT) measure() {
	l.mu.Lock()
	idle := l.lim.CPU == 0 && l.lim.RAMMb == 0 && nowMs() > l.watchTill
	if idle {
		l.prev, l.prevAt = map[int]float64{}, 0
	}
	l.mu.Unlock()
	if idle {
		return
	}
	var roots []int
	for _, s := range liveSessions() {
		roots = append(roots, s.proc.Pid())
	}
	procs := map[int]*proc{}
	if len(roots) > 0 {
		if procs = readPs(); procs == nil {
			return
		}
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	now := nowMs()
	wall := 0.0
	if l.prevAt > 0 {
		wall = (now - l.prevAt) / 1000
	}
	kids := map[int][]*proc{}
	for _, p := range procs {
		kids[p.ppid] = append(kids[p.ppid], p)
	}
	for _, k := range kids { // ps đã theo thứ tự pid; map thì không — xếp lại cho ổn định
		sort.Slice(k, func(i, j int) bool { return k[i].pid < k[j].pid })
	}
	used := func(p *proc) float64 {
		if pr, ok := l.prev[p.pid]; ok && wall > 0 {
			return max(0, p.cpu-pr) / wall
		}
		return 0
	}

	cpu, rssKb, cpuFree := 0.0, 0.0, 0.0
	count := 0
	var nextGroups [][]int
	var candidates []*proc // tiến trình được phép tắt khi vượt RAM
	nextPrev := map[int]float64{}
	// Đi cây: protected = shell phiên, con trực tiếp của nó, và con của mọi shell được bảo vệ.
	var walk func(p *proc, isRoot, isProtected bool, group *[]int)
	walk = func(p *proc, isRoot, isProtected bool, group *[]int) {
		count++
		cpu += used(p)
		rssKb += p.rssKb
		nextPrev[p.pid] = p.cpu
		if isProtected {
			cpuFree += used(p)
		} else {
			*group = append(*group, p.pid)
			candidates = append(candidates, p)
		}
		for _, c := range kids[p.pid] {
			switch {
			case isProtected && (isRoot || shellNameRe.MatchString(p.name)):
				walk(c, false, true, nil)
			case isProtected:
				g := new([]int)
				walk(c, false, false, g)
				nextGroups = append(nextGroups, *g)
			default:
				walk(c, false, false, group)
			}
		}
	}
	for _, pid := range roots {
		if p := procs[pid]; p != nil {
			walk(p, true, true, nil)
		}
	}
	l.prev, l.prevAt = nextPrev, now

	// CPU: nhu cầu thật của cây con = mức đo được / phần thời gian nó được chạy.
	if limitsSupported && l.lim.CPU > 0 && wall > 0 {
		throttled := cpu - cpuFree
		demand := throttled / max(l.duty, minDuty)
		room := max(0, l.lim.CPU-cpuFree)
		want := 1.0
		if demand > room {
			want = max(minDuty, room/demand)
		}
		l.duty = min(1, l.duty*0.5+want*0.5)
		if want == 1 && l.duty > 0.95 {
			l.duty = 1
		}
	} else {
		l.duty = 1
	}

	// Nhóm cũ không còn trong danh sách mới thì cho chạy lại trước khi thay.
	if l.stopped {
		l.resumeAll()
	}
	l.groups = l.groups[:0]
	for _, g := range nextGroups {
		if len(g) > 0 {
			l.groups = append(l.groups, g)
		}
	}

	l.usage = usageInfo{CPU: cpu, RAMMb: rssKb / 1024, Procs: count, Duty: l.duty, At: now}

	// RAM: tắt tiến trình con lớn nhất, chờ RSS giảm rồi mới xét tiếp.
	if limitsSupported && l.lim.RAMMb > 0 && l.usage.RAMMb > l.lim.RAMMb && now-l.lastKill > killCooldownMs {
		gb := func(mb float64) string { return strconv.FormatFloat(mb/1024, 'f', 1, 64) }
		sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].rssKb > candidates[j].rssKb })
		if len(candidates) > 0 {
			big := candidates[0]
			l.lastKill = now
			signalTerm(big.pid)
			signalCont(big.pid)
			time.AfterFunc(3*time.Second, func() { signalKill(big.pid) })
			alert(fmt.Sprintf("Terminals use %s GB of RAM, over the %s GB limit — stopped %s (pid %d, %s GB).", gb(l.usage.RAMMb), gb(l.lim.RAMMb), big.name, big.pid, gb(big.rssKb/1024)))
		} else if now-l.lastWarn > 60e3 {
			l.lastWarn = now
			alert(fmt.Sprintf("Terminals use %s GB of RAM, over the %s GB limit. Only shells and agents are running, so nothing was stopped.", gb(l.usage.RAMMb), gb(l.lim.RAMMb)))
		}
	}
}

func alert(msg string) { emit("alert", map[string]any{"msg": msg}) }

func (l *limiterT) set(next limits) limits {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lim = limits{CPU: max(0, next.CPU), RAMMb: max(0, next.RAMMb)}
	if l.lim.CPU == 0 {
		l.duty = 1
		if l.stopped {
			l.resumeAll()
		}
	}
	return l.lim
}

func (l *limiterT) get() map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.watchTill = nowMs() + 5000
	return map[string]any{"limits": l.lim, "usage": l.usage, "supported": limitsSupported, "cores": runtime.NumCPU(), "totalMb": totalMemMb()}
}

// Thoát khi cây con đang ở pha dừng thì chúng dừng mãi — cho chạy lại trước khi tắt.
func (l *limiterT) stop() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.running {
		close(l.quit)
		l.running = false
	}
	l.duty = 1
	l.resumeAll()
}
