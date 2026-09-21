#!/bin/sh
set -eu
ori_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
# Incomplete package: repository instructions remain available.
export ORI_NO_BUILD=1
exec "$ori_root/scripts/ori" hook
