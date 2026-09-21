#!/bin/sh
set -eu
ori_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
ori_test=$(mktemp -d "${TMPDIR:-/tmp}/ori-test.XXXXXXXX")
trap 'rm -rf "$ori_test"' EXIT HUP INT TERM
node "$ori_root/scripts/binaries.mjs"
node --test "$ori_root/scripts/launcher-test.mjs"
ORI_RUN_TESTS=1 "$ori_root/scripts/build.sh" "$ori_test/ori"
node "$ori_root/scripts/smoke.mjs" "$ori_test/ori" "$ori_test/workspace"
node "$ori_root/scripts/hook-smoke.mjs" "$ori_test/workspace"
