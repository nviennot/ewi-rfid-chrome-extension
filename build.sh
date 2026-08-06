#!/usr/bin/env bash

set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$root_dir/manifest.json")"
output="$root_dir/../ewi-rfid-$version.zip"

cd "$root_dir"

zip -FS -r "$output" \
  manifest.json \
  app.js \
  background.js \
  content.css \
  content.js \
  offscreen.html \
  offscreen.js \
  popup.css \
  popup.html \
  popup.js \
  reader.css \
  reader.html \
  reader.js \
  icons \
  -x "*.DS_Store"

unzip -tqq "$output"

printf 'Built %s\n' "$output"
