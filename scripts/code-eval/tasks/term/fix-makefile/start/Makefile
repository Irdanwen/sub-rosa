CC ?= cc
CFLAGS ?= -Wall -O2

all: hello

hello: hello.o
    $(CC) $(CFLAGS) -o $@ $^

%.o: %.c greet.h
    $(CC) $(CFLAGS) -c $<

clean:
    rm -f *.o hello

.PHONY: all clean
