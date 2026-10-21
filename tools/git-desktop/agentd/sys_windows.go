//go:build windows

package main

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows không có SIGSTOP: bộ giới hạn chỉ đo (limitsSupported = false), không gửi tín hiệu.
func signalStop(int) {}
func signalCont(int) {}
func signalTerm(int) {}
func signalKill(int) {}

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

var globalMemoryStatusEx = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")

func totalMemMb() float64 {
	var m memoryStatusEx
	m.Length = uint32(unsafe.Sizeof(m))
	if r, _, _ := globalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&m))); r == 0 {
		return 0
	}
	return float64(m.TotalPhys) / 1024 / 1024
}
