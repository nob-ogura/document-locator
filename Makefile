UV ?= uv
PYTEST ?= pytest
RUFF ?= ruff
BLACK ?= black
MYPY ?= mypy

.PHONY: sync lint format typecheck test check clean

sync:
	$(UV) sync

lint:
	$(UV) run $(RUFF) check app tests
	$(UV) run $(BLACK) --check app tests

format:
	$(UV) run $(BLACK) app tests

typecheck:
	$(UV) run $(MYPY) app

test:
	$(UV) run $(PYTEST)

check: lint typecheck test

clean:
	rm -rf .mypy_cache .pytest_cache .ruff_cache
