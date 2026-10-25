# Image processing

The root Python files expose Modal apps. Processing logic lives in `app/services/`: `etl.py` coordinates each image, `classifier.py` categorizes and checks duplicates, `orientation.py` detects rotation, and `upscaler.py` produces final wallpapers.

Use the repository-root `scripts/modal.py` wrapper to select `harrir-prod-2` explicitly and set the correct working directory. Runtime dependencies are defined in `app/core/images.py`. `environment.yml` is the historical full local environment; `requirements-cli.txt` is the smaller deployment-client setup.

Category descriptions are in `app/utils/categories.py`. Runtime classification reads generated category embeddings. Classification is skipped for fixed session slugs and desktop-routed images. Model assets and local credentials are ignored by Git; see the root deployment documentation for restoration.

`notebooks/` contains experiments with execution outputs removed. Existing model behavior and database write semantics are preserved by this migration.
