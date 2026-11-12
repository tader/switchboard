#!/bin/sh
# Release-build tooling only. End-user computers download the prepared runtime.
set -eu
arch=${1:?arm64 or x64}
case "$arch" in arm64|x64) ;; *) exit 1;; esac
version=${NODE_RUNTIME_VERSION:-v24.22.3}
base="https://nodejs.org/dist/$version"
work=${2:?output directory}
mkdir -p "$work"
archive="node-$version-darwin-$arch.tar.gz"
curl --fail --location --proto '=https' "$base/$archive" -o "$work/$archive"
curl --fail --location --proto '=https' "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
(cd "$work"; awk -v archive="$archive" '$2 == archive {print}' SHASUMS256.txt > selected.sha256; test -s selected.sha256; shasum -a 256 -c selected.sha256; tar -xzf "$archive")
echo "$work/node-$version-darwin-$arch/bin/node"
