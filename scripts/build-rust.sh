#!/usr/bin/env bash
# Build the full Caliber app for the Rust backend: SPA + backend binary.
# Usage: scripts/build-rust.sh [--debug]
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Installing frontend dependencies"
bun install

echo "==> Building SPA (dist/)"
bun run build

echo "==> Copying pdf.js worker into dist/pdfjs"
mkdir -p dist/pdfjs
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs dist/pdfjs/

PROFILE=release
if [[ "${1:-}" == "--debug" ]]; then
  PROFILE=debug
fi
echo "==> Building Rust backend (${PROFILE})"
if [[ "$PROFILE" == "debug" ]]; then
  cargo build
else
  cargo build --release
fi

echo "==> Done. Run with:"
echo "    CALIBER_STATIC_DIR=dist ./target/${PROFILE}/caliber-server"
