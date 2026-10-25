# Desktop reset — 2026-10-25

The user requested all desktop assets removed, explicitly including review/pending inputs and permanent S3 version deletion. Desktop architecture will be redesigned separately; no replacement architecture is implemented in this change. `premium/` is an old folder layout, not a product tier. Seven landscape images under legacy `premium/Car Desktop/` were included after confirming their dimensions (1664×928).

## Completed cleanup

- AWS identity: Gautam (`arn:aws:iam::071788126830:user/Gautam`); bucket `insta-to-s3`.
- 746 current objects removed: 365 processed desktop outputs, 10 review inputs, 1 leftover raw desktop input, 7 legacy Car Desktop images, and 363 thumbnails.
- Permanently removed 2,181 versions/delete markers across 1,357 object keys, including historical desktop outputs and matching raw originals/thumbnails. Current objects accounted for 7,823,039,897 bytes; all deleted data versions accounted for 9,816,858,202 bytes. These are object sizes, not a billing forecast.
- Deleted 348 corresponding wallpaper database records. Checked the other public reference-bearing tables; no additional matching references or wallpaper foreign keys required cleanup.
- `wallpapers.json`: 20,990 → 20,625 entries. `wallpapers_v2.json`: 18,671 → 18,664 entries. Updates used conditional writes and preserved non-desktop entries.
- Verified all 17 current S3 JSON files: zero remaining desktop references. Verified no targeted current objects or historical versions remain, and no desktop wallpaper records remain.
- CDN invalidation: `I9LD9KXL8YGL3TP1N3S3IFHR21`, 72 paths (9 wildcard paths). The first request exceeded the wildcard limit and was replaced with this smaller request.

Audit snapshots of JSON and database rows, the deletion plan, execution record and verification are stored locally in `/home/rdxtreme/wallee-migration-backups/desktop-reset-20261025-080701`. Desktop image binaries were not backed up; their S3 versions were permanently deleted as requested. Historical shared-catalog versions and local audit records are history, not live image references.

## Desktop pause

`DESKTOP_PIPELINE_PAUSED=1` is the default until the new design is agreed. The ETL worker skips landscape and detected desktop candidates before uploads/queueing. Pause counts are exposed in ingestion results and partial operation records. Portrait phone ingestion continues. Desktop approval returns `status: paused`; direct desktop upscaling rejects calls before processing/storage writes. Worker and upscaler were deployed to `harrir-prod-2`; the live approval endpoint was checked. Existing models remain because phone upscaling uses the x2 model.

Twenty-one Python tests passed, covering pause behavior, active phone ingestion and prior pipeline regressions. The dashboard cache versions were changed so the new production deployment reads the cleaned inventory and manifests. The Import wallpapers screen remains available for phone categories and home collections.
