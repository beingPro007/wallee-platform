.PHONY: help admin-install admin-dev admin-build admin-check proxy-install proxy-dev check check-assets deploy
help:
	@echo "admin-install | admin-dev | admin-build | admin-check | proxy-install | proxy-dev | check | check-assets | deploy"
admin-install:
	npm ci --prefix apps/admin
admin-dev:
	npm run dev --prefix apps/admin
admin-build:
	npm run build --prefix apps/admin
admin-check:
	npm run typecheck --prefix apps/admin
proxy-install:
	npm ci --prefix services/supabase-proxy
proxy-dev:
	npm run dev --prefix services/supabase-proxy
check:
	python3 scripts/check.py
check-assets:
	python3 scripts/assets.py check
deploy:
	python3 scripts/modal.py deploy all
