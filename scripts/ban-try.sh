#!/usr/bin/env bash
set -euo pipefail

if rg -n "^[[:space:]]*try[[:space:]]*\\{|^[[:space:]]*catch[[:space:]]*\\(|^[[:space:]]*rescue\\s+" --glob '!node_modules/**' ; then
  echo "Local try/catch/rescue blocks detected. Please remove them."
  exit 1
fi

echo "No local try/catch/rescue blocks found."

