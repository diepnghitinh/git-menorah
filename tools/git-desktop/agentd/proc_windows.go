//go:build windows

package main

// Windows: ConPTY (Windows 10 1809 trở lên). Chưa chạy thử trên máy Windows thật — PO chấp nhận
// 21/10; build chéo được kiểm.

import (
	"context"
	"os"
	"regexp"
	"strings"
	"sync"
	"syscall"

	"github.com/UserExistsError/conpty"
	"golang.org/x/sys/windows"
)

type winProc struct {
	c         *conpty.ConPty
	closeOnce sync.Once
}

var powershellRe = regexp.MustCompile(`(?i)powershell|pwsh`)

func shellPath() string {
	if c := os.Getenv("COMSPEC"); c != "" && powershellRe.MatchString(c) {
		return c
	}
	return "powershell.exe"
}

func spawnPty(agentCmd, cwd string, env []string, cols, rows int) (ptyProc, error) {
	args := []string{shellPath()}
	if agentCmd != "" {
		args = append(args, "-NoLogo", "-NoExit", "-Command", agentCmd)
	}
	for i, a := range args {
		args[i] = syscall.EscapeArg(a)
	}
	c, err := conpty.Start(strings.Join(args, " "), conpty.ConPtyDimensions(cols, rows), conpty.ConPtyWorkDir(cwd), conpty.ConPtyEnv(env))
	if err != nil {
		return nil, err
	}
	return &winProc{c: c}, nil
}

func (p *winProc) Read(b []byte) (int, error)  { return p.c.Read(b) }
func (p *winProc) Write(b []byte) (int, error) { return p.c.Write(b) }
func (p *winProc) Resize(cols, rows int) error { return p.c.Resize(cols, rows) }
func (p *winProc) Pid() int                    { return p.c.Pid() }

func (p *winProc) Kill() {
	if h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(p.Pid())); err == nil {
		_ = windows.TerminateProcess(h, 1)
		_ = windows.CloseHandle(h)
	}
}
func (p *winProc) KillGroup() { p.Kill() }

// Đóng pseudo console cũng tắt tiến trình con còn gắn vào nó.
func (p *winProc) Close() { p.closeOnce.Do(func() { _ = p.c.Close() }) }

func (p *winProc) Wait() int {
	code, err := p.c.Wait(context.Background())
	if err != nil {
		return -1
	}
	return int(code)
}
