#!/bin/sh

case $0 in
*/*) script_dir=${0%/*} ;;
*) script_dir=. ;;
esac

bun_executable=$(command -v bun 2>/dev/null) || exit 0

reground=$("$bun_executable" "$script_dir/../../src/compaction-reground/compaction-reground.ts" 2>/dev/null) || exit 0

[ -n "$reground" ] || exit 0

printf '%s\n' "$reground"
