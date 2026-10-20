#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
relay_output=${1:-dist}
mkdir -p "$relay_output/licenses/ws"
pnpm exec esbuild src/cli.mts --bundle --platform=node --target=es2022 --format=cjs \
  --external:bufferutil --external:utf-8-validate --outfile="$relay_output/gameRelay.cjs"
cp node_modules/ws/LICENSE "$relay_output/licenses/ws/"
cp node_modules/ws/package.json "$relay_output/licenses/ws/"
cp RELAY_PROTOCOL.md LICENSE "$relay_output/"
