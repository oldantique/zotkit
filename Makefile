NPM ?= npm
PLUGIN_DIR := zotero-plugin

.PHONY: help bootstrap plugin-install plugin-check \
	plugin-test plugin-native-test plugin-native-universal plugin-build verify package

help:
	@echo "bootstrap                Install Zotero plugin build dependencies"
	@echo "plugin-check             Type-check the Zotero plugin"
	@echo "plugin-test              Run the Zotero plugin unit tests"
	@echo "plugin-native-test       Compile and test the native helper on macOS"
	@echo "plugin-build             Build the universal macOS helper and installable XPI"
	@echo "verify                   Run Zotero plugin and native helper checks"
	@echo "package                  Build the universal macOS XPI"

bootstrap: plugin-install

plugin-install:
	$(NPM) --prefix $(PLUGIN_DIR) ci

plugin-check:
	$(NPM) --prefix $(PLUGIN_DIR) run check

plugin-test:
	$(NPM) --prefix $(PLUGIN_DIR) test

plugin-native-test:
	@if [ "$$(uname -s)" = "Darwin" ]; then \
		$(NPM) --prefix $(PLUGIN_DIR) run native:test; \
	else \
		echo "Skipping the macOS-only native helper test on $$(uname -s)."; \
	fi

plugin-native-universal:
	@if [ "$$(uname -s)" != "Darwin" ]; then \
		echo "Universal helper packaging requires macOS (xcrun, lipo, and codesign)." >&2; \
		exit 2; \
	fi
	$(NPM) --prefix $(PLUGIN_DIR) run native:universal

plugin-build: plugin-native-universal
	$(NPM) --prefix $(PLUGIN_DIR) run build

verify: plugin-check plugin-test plugin-native-test

package: plugin-build
