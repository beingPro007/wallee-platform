# Image processing

The root Python files expose Modal apps. Processing logic lives in `app/services/`: `etl.py` coordinates each image, `classifier.py` categorizes and checks duplicates, `orientation.py` detects rotation, and `upscaler.py` produces final wallpapers.

Use the repository-root `scripts/modal.py` wrapper to select `harrir-prod-2` explicitly and set the correct working directory. Runtime dependencies are defined in `app/core/images.py`. `requirements-cli.txt` provides the local deployment-client setup.

Category descriptions are in `app/utils/categories.py`. Runtime classification reads generated category embeddings. Classification is skipped for fixed session slugs and desktop-routed images. Model assets and local credentials are ignored by Git; see the root deployment documentation for restoration.

The standalone search service, text-search API, unused notebook models, and old search-vector artifacts have been removed. Classification, duplicate checks, and output embedding registration remain part of the ingestion pipeline.
