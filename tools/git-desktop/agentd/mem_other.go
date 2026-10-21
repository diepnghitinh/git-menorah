//go:build !darwin && !windows

package main

import "golang.org/x/sys/unix"

func totalMemMb() float64 {
	var si unix.Sysinfo_t
	if unix.Sysinfo(&si) != nil {
		return 0
	}
	return float64(si.Totalram) * float64(si.Unit) / 1024 / 1024
}
