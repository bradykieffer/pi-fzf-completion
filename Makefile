.PHONY: test
test:
	npm test

.PHONY: lint
lint:
	npm run lint

.PHONY: requirements
requirements:
	@command -v fzf >/dev/null || { echo "fzf is required" >&2; exit 1; }
	@command -v fd >/dev/null || { echo "fd is required" >&2; exit 1; }

.PHONY: install
install: requirements
	pi install "$(CURDIR)"
