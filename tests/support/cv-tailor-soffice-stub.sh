#!/usr/bin/env bash
set -euo pipefail

outdir=""
input=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --outdir)
      outdir="$2"
      shift 2
      ;;
    --*)
      shift
      ;;
    -env:*)
      shift
      ;;
    *)
      input="$1"
      shift
      ;;
  esac
done

stem=$(basename "$input" .docx)
case "$stem" in
  *hang-marker*)
    sleep 6
    exit 0
    ;;
esac

script_dir=$(cd "$(dirname "$0")" && pwd)
fixture_pdf="$script_dir/../fixtures/cv-tailor/new.pdf"
mkdir -p "$outdir"
cp "$fixture_pdf" "$outdir/$stem.pdf"
