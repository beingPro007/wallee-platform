# Pipeline validation — 2026-10-25

Latest production deployment and migration results are in [category-path-migration.md](category-path-migration.md). The earlier test and cleanup sections below describe the state before that deployment.

## Offline integration tests

Run with an isolated Python environment:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
make test PYTHON=.venv/bin/python
```

All 12 tests passed, including a clean-checkout run without private environment files or model binaries:

- Classification routing, original image bytes, WebP thumbnail generation, and pending queue record.
- Fixed session category bypassing category prediction.
- Duplicate skipping before S3 writes and queue insertion.
- Existing `misc` fallback when classification fails.
- Trusted Wallhaven landscape routing to desktop upscaling.
- Rotation correction and review metadata.
- Ingestion through queue processing, final JPEG output, dimensions, raw-file cleanup, and S3 manifest update.
- Final-upload failure preserving the original image and marking the job failed.
- Missing input marking the queue job `failed_missing_file` without running the model.
- Imports of all five remaining Modal entry points.
- Direct desktop PNG, thumbnail, manifest, and original cleanup through the repeated-x2 path.
- Upscaler initialization without an x8 model or weight requirement.

Image handling and orchestration execute real service code. Remote classifiers, GPU prediction, S3, Supabase, and the optional Vercel callback are replaced at their boundaries. These tests do not establish model accuracy or live infrastructure availability.

## Authorized live Pinterest test

Source: `https://pin.it/Giq71D7Lw`.
Workspace: `harrir-prod-2`. The run used the cleaned local worker source and existing deployed classifier, orientation service, and upscaler; no production redeployment was performed.

[Initial ingestion run](https://modal.com/apps/harrir-prod-2/main/ap-s5t0Gsr397gNXfV4q0injW): one image downloaded and categorized as `pfp`, with no duplicate or desktop flag. Ingestion reported 41.16 seconds.

| Check | Observed result |
| --- | --- |
| Input JPEG | 675 × 1200; 79,677 bytes |
| Raw S3 key | `raw_images/pfp/pinterest_712976184805895736.jpg` |
| WebP thumbnail | `thumbs/pfp/pinterest_712976184805895736.webp`; 400 × 711; 28,624 bytes |
| Classifier database record | Category `pfp`, 768-dimensional image embedding |
| Queue job | `905f6249-d8ce-45b8-aff6-6f3c9e117a0c` |
| Automatic upscale handoff | **Did not start during observation: queue remained pending and final image absent** |
| Manual webhook submission of this exact job | HTTP 200, `processing_started`, count 1 |
| Final queue state | `completed`, dimensions 1350 × 2400 |
| Final JPEG | `wallpapers/pfp/pinterest_712976184805895736.jpg`; 607,296 bytes |
| Final wallpaper registration | Category `pfp`, 768-dimensional embedding |
| Raw-file cleanup | Original S3 object absent after final upload; thumbnail retained |

Authenticated reads of S3 and Supabase verified these outputs. The image is kept as the authorized live test's result.

[Repeat ingestion run](https://modal.com/apps/harrir-prod-2/main/ap-Z5qTlR6999XlflAHv6Evji): duplicate similarity `1.0`, one image skipped, zero new uploads, 18.07 seconds.

## Remaining live integration issue

The automatic Supabase queue-to-upscaler handoff is not validated as working. The first image remained pending until the exact job was manually submitted to `https://harrir-prod-2--wall-e-upscaler-supabase-webhook.modal.run`. That endpoint and the GPU upscaler then completed successfully. The workspace's recent webhook logs show the manual request.

Inspect the live Supabase database webhook configuration, its target workspace/URL, event filters, and delivery logs. An older `dev-testing` endpoint existed in the original project's test script, but that does not prove the current database uses it. Its Modal profile could not be inspected because a token was unavailable. No webhook configuration, production deployment, or database schema was changed during this test.

The optional uploader session-JSON callback and live desktop-review path were not exercised by this regular `pfp` image.

## Cleanup checks

Python syntax, tracked JSON, credential-pattern checks, ignored environment files, and checksums for the three required model artifacts passed. The admin production build and TypeScript checks passed after removing unused dependencies and enabling unused-local/parameter checks. The removed encoder, proxy, notebook models, and old search indexes are no longer runtime or CI dependencies.

## Dead-code cleanup follow-up

Removed the uncalled desktop-queue/x8 implementation, its extra model initialization and weight requirement, unused configuration and imports, and unused runtime packages (Instaloader, OpenCV, python-dotenv, aiohttp). The live desktop path remains repeated x2 upscaling to 4K/8K. The image build now copies the model code separately from its weights.

The admin retains 11 direct runtime dependencies after 45 unused declarations were removed. The lockfile dropped 135 packages, with no version changes to retained packages. Removed unreferenced starter SVGs, invalid icon links, unused Google Font initialization, unused state/parameters, and unused imports. The production build no longer requests Google Fonts.

No production redeployment or new live image writes were performed during this follow-up. The automatic queue-dispatch issue from the earlier live test remains open.
