package ori

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
)

const Version = "0.1.4"

type Config struct {
	Version    int             `json:"version"`
	Graph      string          `json:"graph"`
	Embeddings EmbeddingConfig `json:"embeddings"`
	Executor   ExecutorConfig  `json:"executor"`
}
type EmbeddingConfig struct {
	Provider string `json:"provider"`
}
type ExecutorConfig struct {
	Command        []string   `json:"command,omitempty"`
	Checks         [][]string `json:"checks,omitempty"`
	MaxAttempts    int        `json:"maxAttempts"`
	TimeoutSeconds int        `json:"timeoutSeconds"`
}
type Workspace struct {
	Root   string
	Config Config
}

func DefaultConfig() Config {
	return Config{Version: 1, Graph: "graph", Embeddings: EmbeddingConfig{Provider: "local"}, Executor: ExecutorConfig{MaxAttempts: 2, TimeoutSeconds: 1800}}
}
func Digest(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func JSON(v any) []byte { b, _ := json.MarshalIndent(v, "", "  "); return append(b, '\n') }
func Decode(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errors.New("expected exactly one JSON value")
	}
	return nil
}
func SafePath(root, rel string) (string, error) {
	if !portablePath(rel) {
		return "", fmt.Errorf("invalid relative path %q", rel)
	}
	if st, err := os.Lstat(root); err == nil && st.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("symlink root is not allowed: %s", root)
	} else if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	p := root
	for _, part := range strings.Split(rel, "/") {
		p = filepath.Join(p, part)
		st, e := os.Lstat(p)
		if e == nil && st.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("symlinks are not allowed: %s", rel)
		}
		if e != nil && !os.IsNotExist(e) {
			return "", e
		}
	}
	return p, nil
}

// Graph and configuration paths are slash-separated even on Windows. Requiring
// canonical paths also prevents two spellings from naming the same graph file.
func portablePath(rel string) bool {
	return rel != "" && rel != "." && rel != ".." && !path.IsAbs(rel) &&
		path.Clean(rel) == rel && !strings.HasPrefix(rel, "../") &&
		!strings.ContainsAny(rel, "\\:\x00\r\n\t")
}
func AtomicWrite(file string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(file), ".ori-write-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(name, file)
}
func Git(root string, args ...string) (string, error) {
	c := exec.Command("git", append([]string{"-C", root}, args...)...)
	var stderr bytes.Buffer
	c.Stderr = &stderr
	b, e := c.Output()
	if e != nil {
		return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(string(b)), nil
}
func Open(root string) (*Workspace, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	for {
		p, e := SafePath(root, ".ori/config.json")
		if e != nil {
			return nil, e
		}
		b, e := os.ReadFile(p)
		if e == nil {
			var cfg Config
			if e = Decode(b, &cfg); e != nil {
				return nil, e
			}
			if e = validateConfig(root, cfg); e != nil {
				return nil, e
			}
			return &Workspace{root, cfg}, nil
		}
		if !os.IsNotExist(e) {
			return nil, e
		}
		parent := filepath.Dir(root)
		if parent == root {
			break
		}
		root = parent
	}
	return nil, errors.New("Ori is not initialized; run ori init in a Git repository")
}

// SaveConfig persists validated configuration without changing this Workspace.
// Open the workspace again to use the new configuration. Graph relocation is an
// explicit migration, never an incidental edit of runtime preferences.
func (w *Workspace) SaveConfig(ctx context.Context, cfg Config) error {
	lock, err := w.AcquireGraphLock(ctx)
	if err != nil {
		return err
	}
	defer lock.Unlock()
	current, err := Open(w.Root)
	if err != nil {
		return err
	}
	if cfg.Graph != current.Config.Graph {
		return errors.New("graph path cannot be changed by a configuration update")
	}
	if err := validateConfig(w.Root, cfg); err != nil {
		return err
	}
	p, err := SafePath(w.Root, ".ori/config.json")
	if err != nil {
		return err
	}
	return AtomicWrite(p, JSON(cfg))
}

func validateConfig(root string, cfg Config) error {
	if cfg.Version != 1 {
		return errors.New("unsupported Ori config version")
	}
	for _, part := range strings.Split(cfg.Graph, "/") {
		if part == ".ori" || part == ".git" {
			return errors.New("graph must be outside .ori and .git")
		}
	}
	if _, err := SafePath(root, cfg.Graph); err != nil {
		return err
	}
	if _, err := SafePath(root, ".ori/state/index.sqlite"); err != nil {
		return err
	}
	if cfg.Executor.MaxAttempts < 1 || cfg.Executor.MaxAttempts > 10 || cfg.Executor.TimeoutSeconds < 1 || cfg.Executor.TimeoutSeconds > 7*24*60*60 {
		return errors.New("executor requires maxAttempts 1–10 and timeoutSeconds 1–604800")
	}
	if cfg.Embeddings.Provider != "local" && cfg.Embeddings.Provider != "off" {
		return errors.New("embeddings.provider must be local or off")
	}
	for _, argv := range append([][]string{cfg.Executor.Command}, cfg.Executor.Checks...) {
		if len(argv) > 0 && strings.TrimSpace(argv[0]) == "" {
			return errors.New("executor command must begin with a nonempty executable")
		}
		for _, arg := range argv {
			if strings.ContainsRune(arg, 0) {
				return errors.New("executor argument contains NUL")
			}
		}
	}
	for _, argv := range cfg.Executor.Checks {
		if len(argv) == 0 {
			return errors.New("executor checks cannot contain an empty command")
		}
	}
	return nil
}
