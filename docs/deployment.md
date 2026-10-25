# Pipeline deployment

## Modal backend

Install `services/image-processing/requirements-cli.txt`. The root wrapper selects `harrir-prod-2` and the correct service working directory:

```sh
python3 scripts/modal.py deploy all
python3 scripts/modal.py run worker --url 'https://pin.it/YOUR_PIN'
```

The deployed apps retain their names:

- `zero-shot-classifier-api` — category classification and duplicate checks (`main.py`). The unused text-search endpoint has been removed from source.
- `wall-e-orientation` — rotation detection (`orientation.py`).
- `wall-e-upscaler` — queue-based and desktop upscaling (`upscaler.py`).
- `wall-e-worker` — download/ingestion coordinator (`worker_modal.py`).

`deploy all` deploys classifier, orientation, upscaler, then worker. Cleanup changes take effect remotely only after deployment. One-off `run worker` executions use the local worker source and the existing deployed classifier/orientation/upscaler.

Keep the existing named secret `wallee-supabase-secrets` and Volumes `wall-e-worker-data` and `wall-e-rotnet`. The worker Volume stores Instagram cookies; RotNet weights remain on the orientation Volume. Supabase's `upscale_queue` webhook must target the intended workspace's upscaler. Live tests should verify queue completion instead of assuming this webhook is configured correctly.

## Model artifacts

The three ignored local assets are the RealESRGAN x2 weights and the classifier's category names/embeddings. Both standard and desktop upscaling use x2; desktop processing repeats it to reach 4K/8K. `artifacts.json` records hashes and sizes.

```sh
python3 scripts/assets.py restore --source-root /home/rdxtreme
python3 scripts/assets.py check
```

For a new machine, transfer these assets from the retained original project or an approved artifact store, then verify checksums. Category embeddings can be regenerated with `python3 scripts/modal.py run categories`; update their manifest hashes deliberately if the categories/model change. Old search vectors and notebook-trained pickle models are no longer required.

## Pipeline UI / Vercel

The retained `apps/admin` interface starts ingestion, shows queue status, approves desktop images, and generates session JSON in S3. Its build callback is used when `VERCEL_BUILD_URL` and `BUILD_WEBHOOK_SECRET` are configured in the upscaler.

For the existing Vercel project `insta-s3-client-uploader`, set the Git source to the platform repository and Root Directory to `apps/admin` when publishing is resumed. Keep its existing environment variables and domains. Run `npm ci` and `npm run build` in that directory. No Vercel reconnection is performed by a local source cleanup.

## Database and maintenance

The retained SQL covers `home_sections` for the pipeline UI, dimensions on `upscale_queue`, and the wallpaper file-path constraint. These are historical changes for an existing database, not a complete bootstrap schema. The file-path constraint migration deletes duplicate rows; review it before executing it. No SQL is run automatically.

The processing service needs `wallpapers` (image vectors/category/file path), `upscale_queue` (job state and S3 paths), and the `match_wallpapers` RPC for deduplication. Desktop jobs call the upscaler directly and do not need a separate desktop queue table.

The optional `sync` utility repairs the wallpaper database against S3 metadata and remains part of image-processing maintenance. It is not a standalone search service. Prune/backfill defaults to dry run; inspect its results before `--apply`.
