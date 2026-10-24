#!/bin/sh
set -e
[ "$(cat answer.txt | tr -d '[:space:]')" = "$(grep -rl 'ORCHID-7731' logs | head -1)" ]
[ "$(grep -rl 'ORCHID-7731' logs | wc -l | tr -d ' ')" = "1" ]
git diff --quiet HEAD -- logs
