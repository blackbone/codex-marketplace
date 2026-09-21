package ori

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

type WebInfo struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
	Root  string `json:"root"`
}

func (i WebInfo) OpenURL() string { return i.URL + "/#token=" + i.Token }

type State struct {
	Snapshot Snapshot          `json:"snapshot"`
	Config   Config            `json:"config"`
	Changes  []json.RawMessage `json:"changes"`
	Runs     []json.RawMessage `json:"runs"`
}

func (w *Workspace) State() (State, error) {
	current, err := Open(w.Root)
	if err != nil {
		return State{}, err
	}
	w = current
	s, e := w.Snapshot("working")
	if e != nil {
		return State{}, e
	}
	c, e := w.Records("changes")
	if e != nil {
		return State{}, e
	}
	r, e := w.Records("runs")
	if e != nil {
		return State{}, e
	}
	return State{s, w.Config, c, r}, nil
}
func jsonResponse(rw http.ResponseWriter, v any, e error) {
	rw.Header().Set("Content-Type", "application/json")
	if e != nil {
		rw.WriteHeader(http.StatusBadRequest)
		v = map[string]string{"error": e.Error()}
	}
	_ = json.NewEncoder(rw).Encode(v)
}
func readRequest(rw http.ResponseWriter, r *http.Request, v any) error {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return errors.New("Content-Type must be application/json")
	}
	b, e := io.ReadAll(http.MaxBytesReader(rw, r.Body, 16<<20))
	if e != nil {
		return e
	}
	return Decode(b, v)
}
func (w *Workspace) Handler(info WebInfo, static fs.FS, stop func()) http.Handler {
	mux := http.NewServeMux()
	currentWorkspace := func(rw http.ResponseWriter) *Workspace {
		current, err := Open(w.Root)
		if err != nil {
			jsonResponse(rw, nil, err)
			return nil
		}
		return current
	}
	mux.HandleFunc("GET /api/health", func(rw http.ResponseWriter, r *http.Request) {
		jsonResponse(rw, map[string]any{"version": Version, "root": w.Root, "pid": info.PID}, nil)
	})
	mux.HandleFunc("GET /api/state", func(rw http.ResponseWriter, r *http.Request) { v, e := w.State(); jsonResponse(rw, v, e) })
	mux.HandleFunc("GET /api/search", func(rw http.ResponseWriter, r *http.Request) {
		current, err := Open(w.Root)
		if err != nil {
			jsonResponse(rw, nil, err)
			return
		}
		w := current
		s, e := w.Snapshot("working")
		if e != nil {
			jsonResponse(rw, nil, e)
			return
		}
		v, e := w.Search(r.Context(), s, r.URL.Query().Get("q"), 20, r.URL.Query().Get("lexical") == "true")
		jsonResponse(rw, v, e)
	})
	mux.HandleFunc("GET /api/impact", func(rw http.ResponseWriter, r *http.Request) {
		w := currentWorkspace(rw)
		if w == nil {
			return
		}
		if strings.TrimSpace(r.URL.Query().Get("ids")) == "" {
			jsonResponse(rw, nil, errors.New("ids required"))
			return
		}
		s, e := w.Snapshot("working")
		if e != nil {
			jsonResponse(rw, nil, e)
			return
		}
		jsonResponse(rw, FindImpact(s, strings.Split(r.URL.Query().Get("ids"), ","), 1000), nil)
	})
	mux.HandleFunc("GET /api/projection", func(rw http.ResponseWriter, r *http.Request) {
		w := currentWorkspace(rw)
		if w == nil {
			return
		}
		s, e := w.Snapshot("working")
		if e != nil {
			jsonResponse(rw, nil, e)
			return
		}
		v, e := Project(s, r.URL.Query().Get("id"))
		jsonResponse(rw, v, e)
	})
	mux.HandleFunc("POST /api/change", func(rw http.ResponseWriter, r *http.Request) {
		w := currentWorkspace(rw)
		if w == nil {
			return
		}
		var req ChangeRequest
		if e := readRequest(rw, r, &req); e != nil {
			jsonResponse(rw, nil, e)
			return
		}
		v, e := w.ProposeChange(r.Context(), req)
		jsonResponse(rw, v, e)
	})
	mux.HandleFunc("POST /api/change/review", func(rw http.ResponseWriter, r *http.Request) {
		w := currentWorkspace(rw)
		if w == nil {
			return
		}
		var req struct {
			ID string `json:"id"`
			ReviewRequest
		}
		if e := readRequest(rw, r, &req); e != nil {
			jsonResponse(rw, nil, e)
			return
		}
		v, e := w.ReviewChange(r.Context(), req.ID, req.ReviewRequest)
		jsonResponse(rw, v, e)
	})
	mux.HandleFunc("POST /api/change/apply", func(rw http.ResponseWriter, r *http.Request) {
		w := currentWorkspace(rw)
		if w == nil {
			return
		}
		var req struct {
			ID string `json:"id"`
		}
		if e := readRequest(rw, r, &req); e != nil {
			jsonResponse(rw, nil, e)
			return
		}
		v, e := w.ApplyChange(r.Context(), req.ID)
		jsonResponse(rw, v, e)
	})
	mux.HandleFunc("PUT /api/config", func(rw http.ResponseWriter, r *http.Request) {
		w := currentWorkspace(rw)
		if w == nil {
			return
		}
		var cfg Config
		if e := readRequest(rw, r, &cfg); e != nil {
			jsonResponse(rw, nil, e)
			return
		}
		if e := w.SaveConfig(r.Context(), cfg); e != nil {
			jsonResponse(rw, nil, e)
			return
		}
		jsonResponse(rw, cfg, nil)
	})
	mux.HandleFunc("POST /api/stop", func(rw http.ResponseWriter, r *http.Request) {
		jsonResponse(rw, map[string]bool{"stopping": true}, nil)
		if stop != nil {
			go stop()
		}
	})
	mux.HandleFunc("/api/", func(rw http.ResponseWriter, r *http.Request) { http.NotFound(rw, r) })
	files := http.FileServerFS(static)
	mux.HandleFunc("/", func(rw http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			rw.Header().Set("Allow", "GET, HEAD")
			http.Error(rw, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		files.ServeHTTP(rw, r)
	})
	host := strings.TrimPrefix(info.URL, "http://")
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Cache-Control", "no-store")
		rw.Header().Set("X-Content-Type-Options", "nosniff")
		rw.Header().Set("Referrer-Policy", "no-referrer")
		rw.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
		if r.Host != host {
			http.Error(rw, "invalid Host", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != info.URL {
			http.Error(rw, "invalid Origin", http.StatusForbidden)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			expected := "Bearer " + info.Token
			if info.Token == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte(expected)) != 1 {
				http.Error(rw, "unauthorized", http.StatusUnauthorized)
				return
			}
		}
		mux.ServeHTTP(rw, r)
	})
}
func (w *Workspace) Serve(ctx context.Context, static fs.FS, port int, open bool, ready func(WebInfo)) error {
	if port < 0 || port > 65535 {
		return errors.New("port must be 0–65535")
	}
	listener, e := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if e != nil {
		return e
	}
	defer listener.Close()
	b := make([]byte, 32)
	if _, e = rand.Read(b); e != nil {
		return e
	}
	info := WebInfo{URL: "http://" + listener.Addr().String(), Token: hex.EncodeToString(b), PID: os.Getpid(), Root: w.Root}
	path, e := SafePath(w.Root, ".ori/state/web.json")
	if e != nil {
		return e
	}
	if e = AtomicWrite(path, JSON(info)); e != nil {
		return e
	}
	defer func() {
		if current, err := w.WebInfo(); err == nil && current.Token == info.Token {
			_ = os.Remove(path)
		}
	}()
	server := &http.Server{ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	done, cancel := context.WithCancel(ctx)
	defer cancel()
	server.Handler = w.Handler(info, static, cancel)
	go func() {
		<-done.Done()
		shutdown, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		_ = server.Shutdown(shutdown)
	}()
	if ready != nil {
		ready(info)
	}
	if open {
		_ = OpenBrowser(info.OpenURL())
	}
	e = server.Serve(listener)
	if errors.Is(e, http.ErrServerClosed) {
		return nil
	}
	return e
}
func OpenBrowser(url string) error {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		c = exec.Command("open", url)
	case "windows":
		c = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		c = exec.Command("xdg-open", url)
	}
	return c.Run()
}
func (w *Workspace) WebInfo() (WebInfo, error) {
	var info WebInfo
	p, e := SafePath(w.Root, ".ori/state/web.json")
	if e != nil {
		return info, e
	}
	b, e := os.ReadFile(p)
	if e != nil {
		return info, e
	}
	if e = Decode(b, &info); e != nil {
		return info, e
	}
	if !w.validWebInfo(info) {
		return info, errors.New("invalid web descriptor")
	}
	return info, nil
}

func (w *Workspace) validWebInfo(info WebInfo) bool {
	u, err := url.Parse(info.URL)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		return false
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 || info.URL != "http://127.0.0.1:"+strconv.Itoa(port) {
		return false
	}
	token, err := hex.DecodeString(info.Token)
	return err == nil && len(token) == 32 && info.Root == w.Root && info.PID > 0
}

func (w *Workspace) WebAlive(info WebInfo) bool {
	if !w.validWebInfo(info) {
		return false
	}
	req, e := http.NewRequest("GET", info.URL+"/api/health", nil)
	if e != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+info.Token)
	// Never forward this local bearer token through a proxy or redirect.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	defer transport.CloseIdleConnections()
	c := &http.Client{Timeout: time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, e := c.Do(req)
	if e != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return false
	}
	var health struct {
		Root    string `json:"root"`
		PID     int    `json:"pid"`
		Version string `json:"version"`
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&health) == nil && health.Root == w.Root && health.PID == info.PID
}
func (w *Workspace) StartWeb(ctx context.Context) (WebInfo, error) {
	lock, e := w.acquireWebStartLock(ctx)
	if e != nil {
		return WebInfo{}, e
	}
	defer lock.Unlock()
	if info, e := w.WebInfo(); e == nil && w.WebAlive(info) {
		return info, nil
	}
	executable, e := os.Executable()
	if e != nil {
		return WebInfo{}, e
	}
	p, e := SafePath(w.Root, ".ori/state/web.log")
	if e != nil {
		return WebInfo{}, e
	}
	if e = os.MkdirAll(filepath.Dir(p), 0700); e != nil {
		return WebInfo{}, e
	}
	log, e := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if e != nil {
		return WebInfo{}, e
	}
	defer log.Close()
	cmd := exec.Command(executable, "--root", w.Root, "web", "--no-open")
	cmd.Dir = w.Root
	cmd.Stdout = log
	cmd.Stderr = log
	if e = cmd.Start(); e != nil {
		return WebInfo{}, e
	}
	go func() { _ = cmd.Wait() }()
	timer := time.NewTimer(15 * time.Second)
	defer timer.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = cmd.Process.Kill()
			return WebInfo{}, ctx.Err()
		case <-timer.C:
			_ = cmd.Process.Kill()
			return WebInfo{}, fmt.Errorf("web did not start; inspect %s", p)
		case <-tick.C:
			if info, e := w.WebInfo(); e == nil && info.PID == cmd.Process.Pid && w.WebAlive(info) {
				return info, nil
			}
		}
	}
}

func (w *Workspace) acquireWebStartLock(ctx context.Context) (*flock.Flock, error) {
	p, err := SafePath(w.Root, ".ori/state/web-start.lock")
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		return nil, err
	}
	lock := flock.New(p)
	ok, err := lock.TryLockContext(ctx, 25*time.Millisecond)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("web start lock was canceled")
	}
	return lock, nil
}
