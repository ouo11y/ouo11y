#!/bin/sh
# Logs the Mac's load averages every 10 s as JSON lines (host epoch seconds), joined to runs by analyze.py.
while true; do
  set -- $(sysctl -n vm.loadavg | tr -d '{}')
  echo "{\"t\": $(date +%s), \"load1\": $1, \"load5\": $2, \"load15\": $3}"
  sleep 10
done
