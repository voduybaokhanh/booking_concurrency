#!/usr/bin/env bash
set -euo pipefail

REPORT_FILE=${1:-audit-report.txt}
echo "Running audit. Results will be written to ${REPORT_FILE}"
{
  echo "== Debug print scan =="
  if rg -n "console\\.log|console\\.debug|puts\\(|print\\s*\\(|printf\\s*\\(" --glob '!node_modules/**' ; then
    echo "Debug prints found above."
  else
    echo "No debug prints found."
  fi

  echo
  echo "== Local try/catch/rescue scan =="
  if rg -n "^[[:space:]]*try[[:space:]]*\\{|^[[:space:]]*catch[[:space:]]*\\(|^[[:space:]]*rescue\\s+" --glob '!node_modules/**' ; then
    echo "Local try/catch/rescue found above."
  else
    echo "No local try/catch/rescue found."
  fi
} > "${REPORT_FILE}"

echo "Audit complete. Review ${REPORT_FILE} to raise remediation tickets."

