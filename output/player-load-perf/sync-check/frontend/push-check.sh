#!/bin/sh
set -e
for check in test:ui test:offline test:player lint build; do
  if npm run "$check" > /tmp/check.log 2>&1; then
    tail -9 /tmp/check.log
  else
    cat /tmp/check.log
    exit 1
  fi
done
