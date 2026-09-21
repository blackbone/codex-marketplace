package assets

import (
	"embed"
	"io/fs"
)

//go:embed all:web/static
var files embed.FS

func Web() fs.FS {
	f, err := fs.Sub(files, "web/static")
	if err != nil {
		panic(err)
	}
	return f
}
