//go:build !windows

package main

import (
	"os"
	"os/exec"
	"sync"
	"syscall"

	"github.com/creack/pty"
)

type unixProc struct {
	cmd       *exec.Cmd
	f         *os.File
	closeOnce sync.Once
}

func shellPath() string {
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	if exists("/bin/zsh") {
		return "/bin/zsh"
	}
	return "/bin/bash"
}

// Shell đăng nhập; có lệnh agent thì chạy agent trong shell đăng nhập (đủ PATH như Terminal),
// agent thoát thì rơi về shell — terminal không chết.
func spawnPty(agentCmd, cwd string, env []string, cols, rows int) (ptyProc, error) {
	sh := shellPath()
	args := []string{"-l"}
	if agentCmd != "" {
		args = append(args, "-i", "-c", agentCmd+`; exec "`+sh+`" -l`)
	}
	cmd := exec.Command(sh, args...)
	cmd.Dir, cmd.Env = cwd, env
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, err
	}
	return &unixProc{cmd: cmd, f: f}, nil
}

func (p *unixProc) Read(b []byte) (int, error)  { return p.f.Read(b) }
func (p *unixProc) Write(b []byte) (int, error) { return p.f.Write(b) }
func (p *unixProc) Resize(cols, rows int) error {
	return pty.Setsize(p.f, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}
func (p *unixProc) Pid() int { return p.cmd.Process.Pid }
func (p *unixProc) Kill()    { _ = syscall.Kill(p.Pid(), syscall.SIGHUP) }
func (p *unixProc) KillGroup() {
	// Setsid: pgid = pid của shell. Agent chạy job riêng thì shell tương tác chuyển SIGHUP cho nó.
	_ = syscall.Kill(-p.Pid(), syscall.SIGHUP)
	_ = syscall.Kill(p.Pid(), syscall.SIGHUP)
}
func (p *unixProc) Close() { p.closeOnce.Do(func() { _ = p.f.Close() }) }

func (p *unixProc) Wait() int {
	err := p.cmd.Wait()
	if err == nil {
		return 0
	}
	if ee, ok := err.(*exec.ExitError); ok {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return 128 + int(ws.Signal())
		}
		return ee.ExitCode()
	}
	return -1
}
