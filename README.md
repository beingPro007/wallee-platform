# Wallee Platform

One repository for Wallee's admin uploader, image processing, search encoder, database migrations, and Supabase proxy. The Flutter mobile app remains in [beingPro007/wallee](https://github.com/beingPro007/wallee).

| Directory | Responsibility | Deployment |
| --- | --- | --- |
| `apps/admin` | Upload URLs, manage collections, review desktop candidates | Next.js / Vercel |
| `services/image-processing` | Ingestion, classification, deduplication, orientation, upscaling, sync | Modal: `harrir-prod-2` |
| `services/search-encoder` | Standalone ONNX text embedding API | Docker / Hugging Face Space |
| `services/supabase-proxy` | Supabase reverse proxy | Cloudflare Worker |
| `infra/supabase` | Shared database migration history | Supabase; apply deliberately |
| `legacy/gradio-classifier` | Earlier standalone CLIP classifier | Preserved Hugging Face / Gradio code |

## Local setup

Use Node.js 22+ and Python 3.11+ for tooling. GPU inference runs inside the Modal images defined by the processor.

```sh
# On a fresh checkout only; do not overwrite existing local credentials.
cp -n apps/admin/.env.example apps/admin/.env.local
make admin-install
make admin-dev
```

Fill in the admin environment file using your existing credentials. The admin-auth Supabase project and wallpaper Supabase project can be different: retain the corresponding values. Local environment files are ignored at every depth; only placeholder examples belong in Git.

```sh
make check                    # offline source/credential checks
make admin-check              # TypeScript
make admin-build              # production build
make check-assets             # ignored model asset checksums
```

## Processing and deployment

```sh
python3 -m pip install -r services/image-processing/requirements-cli.txt
python3 scripts/assets.py restore --source-root /home/rdxtreme
python3 scripts/modal.py run worker --url 'https://wallhaven.cc/...'
python3 scripts/modal.py deploy all
```

The wrapper explicitly defaults to `harrir-prod-2`, independent of the machine's active Modal profile. It keeps the existing deployed app names. Use `--profile` or `MODAL_PROFILE` to intentionally select a different workspace.

Uploads flow through ingestion, duplicate checks, desktop routing, category classification when applicable, S3 storage, and upscaling. Phone images enter `upscale_queue`; desktop images use review or direct upscaling. See [deployment](docs/deployment.md), [environment handling](docs/environment.md), and the [before/after migration table](docs/migration.md).

A source-code migration does not redeploy services, apply SQL, or move production data. The old local folders are retained as recovery sources. Model binaries are stored locally and listed in `artifacts.json`, rather than committed to Git.
