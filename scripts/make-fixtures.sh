#!/bin/sh
# Rebuild fixtures/template.zip: tex2html's template deck, packed.
# Usage: scripts/make-fixtures.sh [path to a tex2html checkout]
set -eu
TEX2HTML=$(cd "${1:-../tex2html}" && pwd)
OUT=$(cd "$(dirname "$0")/.." && pwd)/fixtures
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cp -r "$TEX2HTML/template/." "$WORK/"
rm -rf "$WORK/html" "$WORK/slides.html"
(cd "$WORK" && python3 "$TEX2HTML" main.tex -o slides.html --pack template.zip)
mkdir -p "$OUT"
cp "$WORK/template.zip" "$OUT/template.zip"
echo "wrote $OUT/template.zip"
