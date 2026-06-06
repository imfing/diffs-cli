#!/usr/bin/env sh
set -eu

src="target/release/diffs"
dest="bin/diffs"

mkdir -p bin
cp "$src" "$dest"

if [ "$(uname -s)" = "Darwin" ]; then
  if command -v xattr >/dev/null 2>&1; then
    xattr -d com.apple.provenance "$dest" 2>/dev/null || true
    xattr -d com.apple.quarantine "$dest" 2>/dev/null || true
  fi
  if command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - "$dest" >/dev/null 2>&1 || true
  fi
fi
