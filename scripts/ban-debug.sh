#!/usr/bin/env bash
set -euo pipefail

if rg -n "console\\.log|console\\.debug|puts\\(|print\\s*\\(|printf\\s*\\(" --glob '!node_modules/**' ; then
  echo "Debug prints detected. Please remove them."
  exit 1
fi

echo "No debug prints found."

