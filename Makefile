PYTHON ?= python3

.PHONY: help admin-install admin-dev admin-build admin-check check check-assets test deploy
help:
	@echo "admin-install | admin-dev | admin-build | admin-check | check | check-assets | test | deploy"
admin-install:
	npm ci --prefix apps/admin
admin-dev:
	npm run dev --prefix apps/admin
admin-build:
	npm run build --prefix apps/admin
admin-check:
	npm run typecheck --prefix apps/admin
check:
	$(PYTHON) scripts/check.py
check-assets:
	$(PYTHON) scripts/assets.py check
deploy:
	$(PYTHON) scripts/modal.py deploy all

test:
	$(PYTHON) -m unittest discover -s tests -v
