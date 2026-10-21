package main

import "golang.org/x/sys/unix"

func totalMemMb() float64 {
	n, err := unix.SysctlUint64("hw.memsize")
	if err != nil {
		return 0
	}
	return float64(n) / 1024 / 1024
}
