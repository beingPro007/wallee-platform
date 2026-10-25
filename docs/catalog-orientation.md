# Catalog orientation classification

This explicit batch classifies the union of image paths in all current S3 JSON
catalogs, including entries absent from v2. It uses the existing RotNet ResNet50
weights on `wall-e-rotnet`. It does not rotate, upscale, move or delete images,
write S3 objects, change catalog JSON, enqueue jobs, or update database rows.
Desktop ingestion/publishing remains paused.

The independent Modal app `wall-e-catalog-orientation` runs in `harrir-prod-2`
with one T4, 24 physical CPU cores, 32 GiB memory, 24 download/preprocessing
threads, and GPU batches of 24. Torch's internal CPU pools use one thread to
avoid nested thread oversubscription. GPU inference remains FP32. There is no
schedule or public web endpoint, and it scales to zero after a run.

The threshold defaults to 0.95 and comparison is strictly greater than (>).
Every decodable image retains its four class probabilities and predicted angle
(0/90/180/270). Nonzero predictions above threshold are `rotation_candidate`;
zero predictions above threshold are `upright`. All other predictions are
`skipped`, including scores exactly equal to 0.95. There is no review requirement
or review list. The rotation selection contains only qualifying nonzero
predictions. Confidence is a model score, not a measured accuracy guarantee.

Input images are normalized using EXIF orientation before the existing
Resize288/CenterCrop288 preprocessing. Both stored and display dimensions are
recorded. Suggested correction angles are relative to that EXIF-normalized
image. Classification is independent of portrait/landscape desktop routing.
Downloads are bounded at 512 MiB and decoded images at 512 megapixels. Decodes
above 64 megapixels are serialized to contain memory use; ordinary images use
all 24 preprocessing threads. The catalog includes originals larger than
200 megapixels, so Pillow's lower default pixel limit is adjusted explicitly.

The local runner reads explicit credentials from ignored `apps/admin/.env`
and verifies the Gautam ARN and bucket. The remote worker gets expiring GET-only
signed URLs with ETag preconditions. AWS credentials never enter the worker;
signed URLs are not saved in report files or printed in logs. Files changed
since the inventory are recorded as errors rather than classified silently.

Reports live in Modal Volume `wall-e-catalog-orientation-reports/<run-id>`.
Every 96 images, a shard and progress file are committed. Final output contains
one JSONL record per unique source key, a summary, and a manifest with the
model SHA256. Resubmitting the same snapshot refreshes URLs, skips completed
classifications, and retries errors. Changed inputs/model/threshold require a
new run ID. Do not submit the same run ID concurrently.

From the repository root, with boto3 and Modal installed:

```sh
python scripts/modal.py deploy catalog-orientation --profile harrir-prod-2
python scripts/catalog_orientation.py snapshot /private/reports/catalog-YYYYMMDD
MODAL_PROFILE=harrir-prod-2 python scripts/catalog_orientation.py submit /private/reports/catalog-YYYYMMDD
MODAL_PROFILE=harrir-prod-2 python scripts/catalog_orientation.py status /private/reports/catalog-YYYYMMDD
MODAL_PROFILE=harrir-prod-2 python scripts/catalog_orientation.py fetch /private/reports/catalog-YYYYMMDD
```

`submit` spawns a durable remote invocation; closing the CLI does not cancel it.
`fetch` retrieves completed results locally. Keep report directories outside the
repository. The existing ingestion orientation deployment is unchanged.

Fetching also checks exact snapshot coverage, source ETags, probability totals,
and threshold decisions, then exports `classifications.csv`,
`rotation-candidates.csv`. The old `uncertain.csv` review list is removed.
`export` reapplies the current selection policy to downloaded scores without
inference; resumed workers also reapply it to cached results. These are
classification reports; no suggested correction has been applied to any image.

## Completed run: 25 October 2026

Run `catalog-orientation-20261025-full` covered 20,786 unique paths from all 17
current catalogs. Every path existed in the fresh S3 inventory. The 48-image
smoke test completed without errors before the full pass was submitted.

| Classification with confidence > 0.95 | Images |
| --- | ---: |
| Upright | 13,880 |
| Rotation candidate | 1,565 |
| Skipped | 5,341 |
| Remaining failures | 0 |

The first pass took about 32 minutes 40 seconds and encountered ten file-size
or pixel-count limit errors. Their headers showed valid images up to 357,861,504
pixels. After deploying bounded, serialized large-image decoding, resumption
classified those ten in about 42 seconds while reusing the 20,776 successful
records. These timings exclude container startup and final report transfer.

Model SHA256:
`c845db7a8960bb930fe87112c898af00b8212814744775e9e3acc955c3bba393`.

Private local reports:
`/home/rdxtreme/wallee-migration-backups/catalog-orientation-20261025-full/`.
The directory includes the original snapshot, both invocation IDs, initial
failures, final results, and selection CSVs. No image correction, upscaling,
S3/catalog mutation, database update, or desktop publication was performed.

The user subsequently selected a strict >95% rule with no review step. Saved
scores were filtered again without GPU inference; the 1,565 qualifying candidates
remain selected and the other 5,341 low-confidence results are skipped.

Validation: 28 offline Python tests passed, including exact-threshold exclusion
and exporting legacy scores without a review list. The live smoke report passed
coverage checks, and all ten large-image retries succeeded.
