//go:build !windows

package main

import "syscall"

func signalStop(pid int) { _ = syscall.Kill(pid, syscall.SIGSTOP) }
func signalCont(pid int) { _ = syscall.Kill(pid, syscall.SIGCONT) }
func signalTerm(pid int) { _ = syscall.Kill(pid, syscall.SIGTERM) }
func signalKill(pid int) { _ = syscall.Kill(pid, syscall.SIGKILL) }
