#!/bin/sh
set -e
git diff --quiet HEAD -- hello.c greet.c greet.h
make clean >/dev/null 2>&1 || true
make >/dev/null
[ "$(./hello)" = "hello, bench" ]
make clean >/dev/null
[ ! -e hello ] && [ ! -e hello.o ] && [ ! -e greet.o ]
