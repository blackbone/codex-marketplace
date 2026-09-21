//go:build darwin || linux || freebsd || netbsd || openbsd || dragonfly

package ori

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// Give each execution its own process group: a timed-out agent must not leave
// compilers or shell children modifying the retained worktree in the background.
func isolateRunProcess(c *exec.Cmd) func() {
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	kill := func() error {
		if c.Process == nil {
			return os.ErrProcessDone
		}
		e := syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
		if errors.Is(e, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return e
	}
	c.Cancel = kill
	return func() { _ = kill() }
}
