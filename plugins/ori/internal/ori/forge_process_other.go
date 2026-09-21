//go:build !darwin && !linux && !freebsd && !netbsd && !openbsd && !dragonfly

package ori

import "os/exec"

// CommandContext still cancels the direct process on other systems.
func isolateRunProcess(c *exec.Cmd) func() { return func() {} }
