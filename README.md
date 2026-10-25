# Wallee Platform — Image Ingestion Pipeline

This repository focuses on getting images from Instagram, Pinterest, and Wallhaven into S3: download, classify, check duplicates, detect rotation, generate thumbnails, and upscale.

| Component | Purpose |
| --- | --- |
| `services/image-processing` | The processing backend, deployed on Modal in `harrir-prod-2` |
| `apps/admin` | Pipeline interface: submit URLs, review desktop candidates, monitor jobs, and publish session JSON to S3 |
| `infra/supabase/migrations` | Existing pipeline-related queue, wallpaper, and uploader-section migrations |
| `scripts` | Deployment, model-asset checks, and credential checks |
| `tests` | Offline integration tests for ingestion and upscaling orchestration |

The standalone text encoder, Supabase proxy, earlier Gradio classifier, experimental notebooks, and mobile-only SQL were removed. The mobile app remains in its separate repository.

## Run the pipeline

```sh
python3 -m pip install -r services/image-processing/requirements-cli.txt
python3 scripts/assets.py check
python3 scripts/modal.py run worker --url 'https://pin.it/YOUR_PIN'
# Optional fixed category/collection:
python3 scripts/modal.py run worker --url 'https://pin.it/YOUR_PIN' --session-slug my-collection
```

The deployment wrapper explicitly selects `harrir-prod-2` by default, independent of the active local Modal profile. Use `--profile` or `MODAL_PROFILE` to intentionally choose another workspace. The existing Modal secret `wallee-supabase-secrets` supplies cloud credentials.

## Pipeline behavior

```text
URL → download → duplicate check → orientation/desktop routing
                                      ├─ regular image → category → raw S3 + thumbnail
                                      │                  → upscale_queue → upscaler → final S3
                                      └─ desktop image → review or direct upscaling → final S3
```

Duplicate images are skipped. A session slug bypasses category prediction. Desktop candidates are staged for review by default. CLIP image encoding and category text embeddings remain necessary for classification and deduplication; removing the separate search service does not remove these model components.

## Test locally

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
make test PYTHON=.venv/bin/python
make check
make check-assets
```

The offline tests use actual image serialization, thumbnail generation, queue orchestration, and output handling with in-memory S3/database clients and simulated model predictions. They do not establish GPU model accuracy or remote availability. See [validation](docs/validation.md) for live-test results and limits.

## Uploader interface

```sh
# Fresh checkout only; preserve existing local credentials.
cp -n apps/admin/.env.example apps/admin/.env.local
make admin-install
make admin-dev
```

The uploader remains because it operates the pipeline and writes session JSON to S3. The backend can also be invoked directly without the UI.

See [deployment](docs/deployment.md), [environment handling](docs/environment.md), and the [keep/remove comparison](docs/migration.md). Real `.env` files and model binaries remain local and ignored. No live services or databases are removed by this source cleanup.
