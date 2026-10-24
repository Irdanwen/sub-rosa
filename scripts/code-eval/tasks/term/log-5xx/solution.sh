#!/bin/sh
awk '$9 ~ /^5/ {print $1}' access.log | sort | uniq -c | awk '{print $2, $1}' | sort -k2,2nr -k1,1 | head -3 > report.txt
