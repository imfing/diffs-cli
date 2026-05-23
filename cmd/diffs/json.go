package main

import (
	"encoding/json"
	"io"
)

func writeJSONCLI(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}
