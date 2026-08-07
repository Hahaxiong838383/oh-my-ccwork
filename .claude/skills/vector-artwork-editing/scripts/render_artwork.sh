#!/bin/sh
set -eu

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 INPUT OUTPUT.png [DPI]" >&2
  exit 64
fi

input=$1
output=$2
dpi=${3:-300}
[ -f "$input" ] || { echo "input not found: $input" >&2; exit 66; }
mkdir -p "$(dirname "$output")"

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/vector-render.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT INT TERM
kind=$(file -b "$input")

case "$kind" in
  *PDF\ document*)
    cp "$input" "$tmpdir/source.pdf"
    pdftoppm -f 1 -singlefile -r "$dpi" -png "$tmpdir/source.pdf" "${output%.png}" >/dev/null
    ;;
  *SVG*|*XML*)
    cp "$input" "$tmpdir/source.svg"
    inkscape "$tmpdir/source.svg" --export-type=png --export-filename="$output" --export-dpi="$dpi" >/dev/null 2>&1
    ;;
  *)
    echo "unsupported real format: $kind" >&2
    exit 65
    ;;
esac

file "$output"
