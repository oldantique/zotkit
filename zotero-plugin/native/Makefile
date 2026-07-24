SHELL := /bin/sh
CC ?= clang
CFLAGS ?= -O2 -std=c17 -Wall -Wextra -Wpedantic -Werror
BUILD_DIR := build
TARGET := $(BUILD_DIR)/zoterochat-helper
SOURCE := src/zoterochat_helper.c

.PHONY: all test universal clean

all: $(TARGET)

$(TARGET): $(SOURCE)
	@mkdir -p $(BUILD_DIR)
	$(CC) $(CFLAGS) $(SOURCE) -o $(TARGET)

test: $(TARGET)
	HELPER="$(abspath $(TARGET))" python3 tests/test_helper.py

universal:
	./scripts/build-universal.sh

clean:
	rm -rf build dist
