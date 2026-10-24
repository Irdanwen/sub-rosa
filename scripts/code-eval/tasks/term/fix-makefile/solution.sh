#!/bin/sh
printf 'CC ?= cc\nCFLAGS ?= -Wall -O2\n\nall: hello\n\nhello: hello.o greet.o\n\t$(CC) $(CFLAGS) -o $@ $^\n\n%%.o: %%.c greet.h\n\t$(CC) $(CFLAGS) -c $<\n\nclean:\n\trm -f *.o hello\n\n.PHONY: all clean\n' > Makefile
