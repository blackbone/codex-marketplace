package ori

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gofrs/flock"
	"github.com/gomlx/go-huggingface/tokenizers/api"
	"github.com/knights-analytics/hugot"
	"github.com/knights-analytics/hugot/backends"
	"github.com/knights-analytics/hugot/pipelines"
)

const ModelRevision = "2c4055b12046f11709e9df2c122e59ffbdc2f900"
const EmbeddingFingerprint = "multilingual-minilm:" + ModelRevision + ":hugot-0.7.8:mean-normalized:chunks128:v2"

var modelFiles = []struct {
	Remote, Local, Hash string
	Size                int64
}{
	{"onnx/model.onnx", "model.onnx", "185ae63f47e17a7e8d30d0e6a3cde6a6e4b79bc5b81666ecffc279a6856ca113", 470268510},
	{"tokenizer.json", "tokenizer.json", "b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441", 17082913},
	{"config.json", "config.json", "05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7", 673},
	{"tokenizer_config.json", "tokenizer_config.json", "3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2", 496},
	{"special_tokens_map.json", "special_tokens_map.json", "06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f", 280},
}

type Embedder struct {
	gate     chan struct{}
	session  *hugot.Session
	pipeline *pipelines.FeatureExtractionPipeline
}

var sharedModel = struct {
	gate  chan struct{}
	value *Embedder
}{gate: make(chan struct{}, 1)}

// ModelMaxTokens is the sentence-transformer training window, including special tokens.
const ModelMaxTokens = 128
const EmbeddingDimensions = 384

func acquire(ctx context.Context, gate chan struct{}) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case gate <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func ModelDir() (string, error) {
	base := os.Getenv("PLUGIN_DATA")
	if base == "" {
		var e error
		base, e = os.UserCacheDir()
		if e != nil {
			return "", e
		}
		base = filepath.Join(base, "ori")
	}
	base, e := filepath.Abs(base)
	if e != nil {
		return "", e
	}
	return SafePath(base, "models/"+ModelRevision)
}
func verifyModelFile(p, hash string, size int64) bool {
	f, e := os.Open(p)
	if e != nil {
		return false
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil || st.Size() != size {
		return false
	}
	h := sha256.New()
	if _, e = io.Copy(h, f); e != nil {
		return false
	}
	return hex.EncodeToString(h.Sum(nil)) == hash
}
func DownloadModel(ctx context.Context) (string, error) {
	dir, e := ModelDir()
	if e != nil {
		return "", e
	}
	if e = os.MkdirAll(dir, 0700); e != nil {
		return "", e
	}
	lockPath, e := SafePath(dir, "download.lock")
	if e != nil {
		return "", e
	}
	lock := flock.New(lockPath)
	ok, e := lock.TryLockContext(ctx, 200*time.Millisecond)
	if e != nil {
		return "", e
	}
	if !ok {
		return "", errors.New("model download lock unavailable")
	}
	defer lock.Unlock()
	client := &http.Client{Timeout: 20 * time.Minute}
	for _, item := range modelFiles {
		if e := ctx.Err(); e != nil {
			return "", e
		}
		p, e := SafePath(dir, item.Local)
		if e != nil {
			return "", e
		}
		if verifyModelFile(p, item.Hash, item.Size) {
			continue
		}
		fmt.Fprintf(os.Stderr, "Ori Scout: downloading %s (%d MiB)\n", item.Local, item.Size/(1<<20))
		req, e := http.NewRequestWithContext(ctx, "GET", "https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/"+ModelRevision+"/"+item.Remote, nil)
		if e != nil {
			return "", e
		}
		response, e := client.Do(req)
		if e != nil {
			return "", e
		}
		if response.StatusCode != 200 {
			response.Body.Close()
			return "", fmt.Errorf("model download: HTTP %d", response.StatusCode)
		}
		f, e := os.CreateTemp(dir, ".download-*")
		if e != nil {
			response.Body.Close()
			return "", e
		}
		name := f.Name()
		h := sha256.New()
		n, copyErr := io.Copy(io.MultiWriter(f, h), io.LimitReader(response.Body, item.Size+1))
		response.Body.Close()
		syncErr := f.Sync()
		closeErr := f.Close()
		if err := errors.Join(copyErr, syncErr, closeErr); err != nil {
			os.Remove(name)
			return "", fmt.Errorf("model download failed: %s: %w", item.Local, err)
		}
		if n != item.Size || hex.EncodeToString(h.Sum(nil)) != item.Hash {
			os.Remove(name)
			return "", fmt.Errorf("model download failed integrity check: %s", item.Local)
		}
		if e = os.Rename(name, p); e != nil {
			os.Remove(name)
			return "", e
		}
	}
	return dir, nil
}
func GetEmbedder(ctx context.Context) (*Embedder, error) {
	if err := acquire(ctx, sharedModel.gate); err != nil {
		return nil, err
	}
	defer func() { <-sharedModel.gate }()
	if sharedModel.value != nil {
		return sharedModel.value, nil
	}
	dir, e := DownloadModel(ctx)
	if e != nil {
		return nil, e
	}
	session, e := hugot.NewGoSession(context.Background())
	if e != nil {
		return nil, e
	}
	p, e := hugot.NewPipeline(session, hugot.FeatureExtractionConfig{ModelPath: dir, Name: "ori-scout", OnnxFilename: "model.onnx", Options: []backends.PipelineOption[*pipelines.FeatureExtractionPipeline]{pipelines.WithNormalization()}})
	if e != nil {
		session.Destroy()
		return nil, e
	}
	// Pure-Go inference does not pad sequence shapes. Single-item batches and
	// the token limit bound the graph cache to 128 possible shapes.
	p.Model.GoMLXModel.Exec.SetMaxCache(ModelMaxTokens)
	// Disable tokenizer truncation: Ori splits explicitly and never drops a text tail.
	if e = p.Model.Tokenizer.GoTokenizer.Tokenizer.With(api.EncodeOptions{AddSpecialTokens: true}); e != nil {
		session.Destroy()
		return nil, e
	}
	sharedModel.value = &Embedder{session: session, pipeline: p, gate: make(chan struct{}, 1)}
	return sharedModel.value, nil
}

// Chunks preserves every rune and limits each fragment to the model's real token window.
func (e *Embedder) Chunks(ctx context.Context, text string) ([]string, error) {
	if err := acquire(ctx, e.gate); err != nil {
		return nil, err
	}
	defer func() { <-e.gate }()
	return e.chunks(ctx, text)
}
func (e *Embedder) chunks(ctx context.Context, text string) ([]string, error) {
	out := []string{}
	// Coarse overlapping windows avoid tokenizing an entire multi-megabyte component at once.
	var split func(string) error
	split = func(part string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		count := len(e.pipeline.Model.Tokenizer.GoTokenizer.Tokenizer.Encode(part))
		if count <= ModelMaxTokens {
			out = append(out, part)
			return nil
		}
		r := []rune(part)
		if len(r) < 2 {
			return errors.New("one character exceeds model token window")
		}
		mid := len(r) / 2
		if err := split(string(r[:mid])); err != nil {
			return err
		}
		return split(string(r[mid:]))
	}
	for _, part := range textChunks(text) {
		if err := split(part); err != nil {
			return nil, err
		}
	}
	return out, nil
}
func (e *Embedder) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	if err := acquire(ctx, e.gate); err != nil {
		return nil, err
	}
	defer func() { <-e.gate }()
	out := make([][]float32, 0, len(texts))
	for _, text := range texts {
		if strings.TrimSpace(text) == "" {
			return nil, errors.New("cannot embed empty text")
		}
		chunks, err := e.chunks(ctx, text)
		if err != nil {
			return nil, err
		}
		sum := make([]float32, EmbeddingDimensions)
		for _, chunk := range chunks {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			// Hugot cancellation returns while its executor goroutine is still running.
			// Finish this bounded CPU step before releasing the model; honour cancellation
			// immediately afterwards and between chunks.
			r, err := e.pipeline.RunPipeline(context.WithoutCancel(ctx), []string{chunk})
			if err != nil {
				return nil, err
			}
			if len(r.Embeddings) != 1 {
				return nil, errors.New("model returned unexpected vector count")
			}
			if err := validateEmbedding(r.Embeddings[0]); err != nil {
				return nil, err
			}
			for i, v := range r.Embeddings[0] {
				sum[i] += v
			}
		}
		norm := 0.0
		for _, v := range sum {
			norm += float64(v) * float64(v)
		}
		if norm == 0 {
			return nil, errors.New("model returned zero embedding")
		}
		for i := range sum {
			sum[i] /= float32(math.Sqrt(norm))
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		out = append(out, sum)
	}
	return out, nil
}
func validateEmbedding(v []float32) error {
	if len(v) != EmbeddingDimensions {
		return fmt.Errorf("embedding dimensions: got %d, want %d", len(v), EmbeddingDimensions)
	}
	norm := 0.0
	for _, x := range v {
		f := float64(x)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return errors.New("non-finite embedding value")
		}
		norm += f * f
	}
	if norm == 0 {
		return errors.New("embedding has zero norm")
	}
	return nil
}
