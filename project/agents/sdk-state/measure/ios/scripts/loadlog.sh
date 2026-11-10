#!/bin/sh
# Logs the host load averages every 5 s: "<unix time> <1 min> <5 min> <15 min>" (from sysctl vm.loadavg, the numbers uptime prints).
while true; do
  echo "$(python3 -c 'import time;print(round(time.time(),1))') $(sysctl -n vm.loadavg | tr -d '{}')"
  sleep 5
done
