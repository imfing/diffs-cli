package webassets

import (
	"embed"
	"io/fs"
)

//go:embed dist
var dist embed.FS

func DistFS() (fs.FS, error) {
	return fs.Sub(dist, "dist")
}
