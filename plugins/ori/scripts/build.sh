#!/bin/sh
set -eu

ori_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
ori_all=0
if [ "${1:-}" = --all ]; then
  ori_all=1
  shift
fi
if [ "$ori_all" = 1 ]; then
  ori_output=${1:-"$ori_root/bin"}
else
  ori_output=${1:-"$ori_root/bin/ori"}
fi
case "$ori_output" in /*) ;; *) ori_output="$PWD/$ori_output" ;; esac
for ori_tool in go npm tar; do
  command -v "$ori_tool" >/dev/null 2>&1 || { echo "Ori build requires $ori_tool on PATH." >&2; exit 1; }
done
ori_build=$(mktemp -d "${TMPDIR:-/tmp}/ori-build.XXXXXXXX")
trap 'rm -rf "$ori_build"' EXIT HUP INT TERM
mkdir -p "$(dirname -- "$ori_output")"
# Build in a disposable copy: installed plugin sources may be read-only.
(cd "$ori_root" && tar --exclude=node_modules --exclude=.git --exclude=bin --exclude=dist --exclude=static -cf - go.mod go.sum assets.go cmd internal web) | (cd "$ori_build" && tar -xf -)
(cd "$ori_build/web" && npm ci --no-audit --no-fund && npm run build) >&2
if [ "${ORI_RUN_TESTS:-0}" = 1 ]; then
  (cd "$ori_build/web" && npm test) >&2
  (cd "$ori_build" && CGO_ENABLED=0 go test ./...) >&2
fi
if [ "$ori_all" = 1 ]; then
  # Compile all targets before replacing any packaged binaries.
  for ori_os in darwin linux windows; do
    for ori_arch in amd64 arm64; do
      ori_name=ori
      if [ "$ori_os" = windows ]; then ori_name=ori.exe; fi
      ori_target="$ori_os-$ori_arch/$ori_name"
      mkdir -p "$ori_build/bin/$ori_os-$ori_arch"
      echo "Building $ori_target" >&2
      (cd "$ori_build" && CGO_ENABLED=0 GOOS="$ori_os" GOARCH="$ori_arch" go build -trimpath -buildvcs=false -ldflags='-s -w' -o "$ori_build/bin/$ori_target" ./cmd/ori) >&2
    done
  done
  mkdir -p "$ori_output"
  cp -R "$ori_build/bin/." "$ori_output/"
  node "$ori_root/scripts/binaries.mjs" --write "$ori_output"
  echo "Built all Ori platforms in $ori_output" >&2
  exit 0
fi
(cd "$ori_build" && CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w' -o "$ori_build/ori" ./cmd/ori) >&2
ori_output_tmp=$(mktemp "${ori_output}.XXXXXXXX")
cp "$ori_build/ori" "$ori_output_tmp"
chmod 755 "$ori_output_tmp"
mv -f "$ori_output_tmp" "$ori_output"
echo "Built $ori_output" >&2
