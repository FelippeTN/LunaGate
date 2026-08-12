// Package web holds the built frontend, embedded into the binary. The dist
// directory is produced by `npm run build` in this directory.
package web

import "embed"

//go:embed all:dist
var Dist embed.FS
