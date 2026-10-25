# Deployment

The services share a Git repository but keep independent runtimes. No production deployment or database migration is performed automatically by this repository's CI.

## Admin / Vercel

Use the existing Vercel project `insta-s3-client-uploader`. Connect `beingPro007/wallee-platform` and set Root Directory to `apps/admin`. Preserve its current environment variables and domains. The app has its own `package-lock.json` and `.npmrc`; run `npm ci` and `npm run build` from that directory. Changing the Git source does not copy environment variables; retain the existing project configuration.

The old project's provider association is not imported automatically. Verify a preview build and its environment before changing production routing. The UI's original branding is preserved by this source migration.

## Modal

Install `services/image-processing/requirements-cli.txt` in a local virtual environment. The deployment wrapper defaults to profile `harrir-prod-2` and sets the working directory correctly. The four apps remain:

- `zero-shot-classifier-api` — `main.py`
- `wall-e-orientation` — `orientation.py`
- `wall-e-upscaler` — `upscaler.py`
- `wall-e-worker` — `worker_modal.py`

`python3 scripts/modal.py deploy all` deploys classifier, orientation, upscaler, then worker. The `sync` entry point is available separately for explicit maintenance. Secret and Volume names remain unchanged, including `wallee-supabase-secrets`, `wall-e-worker-data`, and `wall-e-rotnet`. Instagram sessions/cookies belong on the worker Volume.

The existing Supabase `upscale_queue` webhook must point at the upscaler in the intended workspace. A live webhook destination was not audited during the source migration. Do not use the old test endpoint in `dev-testing`.

### Model artifacts

Model files are excluded from Git. The migration retained local copies and records their sizes and SHA-256 hashes in `artifacts.json`.

```sh
python3 scripts/assets.py restore --source-root /home/rdxtreme
python3 scripts/assets.py check
```

For a different machine, securely transfer the listed files from the retained source folders or an approved artifact store to the same relative paths, then run the checksum check. Category embeddings can also be regenerated with `python3 scripts/modal.py run categories`; regenerate the manifest deliberately if changing models/categories. Orientation weights remain on the existing Modal Volume.

## Cloudflare proxy

```sh
cd services/supabase-proxy
npm ci
npm run check
npm run deploy
```

Keep the existing Worker name from `wrangler.toml`. Use your Cloudflare account's authentication; provider caches are not committed.

## Search encoder and earlier classifier

The ONNX API can be built from `services/search-encoder` after restoring `model.onnx`: `docker build -t wallee-search services/search-encoder`. It uses port 7860. The current mobile app generates text embeddings through Rust; this separate API is retained for existing consumers.

The original Hugging Face Spaces are not deleted by the GitHub consolidation. Their deployment linkage remains separate. The Gradio classifier in `legacy/gradio-classifier` uses a different CLIP setup from the Modal classifier; do not substitute it silently.

## Supabase

`infra/supabase/migrations` preserves the existing mobile repository's ordered SQL history. `reference/uploader_home_sections.sql` is an overlapping setup script retained for comparison, not another migration. Do not apply it after the equivalent timestamped migration.

These migrations are historical, not a newly validated clean-database bootstrap. Match the target database and its applied migration ledger before any `db push`. The mobile repository was left intact; future schema changes should be coordinated from this platform repository to avoid divergent migration histories.
