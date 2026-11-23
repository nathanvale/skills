#!/bin/sh

case $0 in
*/*) script_dir=${0%/*} ;;
*) script_dir=. ;;
esac

bun_executable=$(command -v bun 2>/dev/null) || exit 0

CDPATH= cd -- "$script_dir" >/dev/null 2>&1 || exit 0

reground=$("$bun_executable" --no-env-file ../../src/compaction-reground/compaction-reground.ts 2>/dev/null) || exit 0

[ -n "$reground" ] || exit 0

printf '%s\n' "$reground"
