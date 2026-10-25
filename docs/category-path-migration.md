# Category-path migration — 2026-10-25

Standard upscaling now publishes `{category}/{filename}.jpg`, rather than
`wallpapers/{category}/{filename}.jpg`. Desktop paths remain unchanged.

## Production changes

- Used AWS IAM user `Gautam` in account `071788126830`, bucket `insta-to-s3`.
- Copied and verified 915 images (1,412,696,720 bytes) to category paths, with no
  destination collisions. Compared content hashes when multipart source ETags
  differed from the copy's ETag. No re-encoding was used for the migration.
- Rewrote 915 references in `wallpapers.json`, removed one already-broken entry,
  and rewrote 248 entries in `wallpapers_v2.json` without changing its selection.
  Nine session manifests had 240 references rewritten. All 16 manifests were checked.
- Migrated 895 wallpaper database records, merging 511 duplicate path aliases into
  existing category records. Preserved the original category record IDs and updated
  their embeddings. Verified there are no foreign keys targeting `wallpapers`.
- Updated one retained queue result, 52 favourites, 68 collection entries, and five
  collection covers. No `wallpapers/` paths remain in the main wallpaper table.
- Published CloudFront Function `wallee-category-paths-20261025` on distribution
  `E2VYY9XQB5FRGW`. Old image URLs resolve to their category paths so mobile caches
  and shared links continue to work. The `/wallpapers-secure` behavior is unchanged.
- Removed the 915 old current S3 keys after validating the copies, database and
  manifests. S3 version history remains available for rollback; this was not a
  permanent purge of historical object versions.

## Deployments and tests

- Modal `wall-e-upscaler`, workspace `harrir-prod-2`:
  https://modal.com/apps/harrir-prod-2/main/deployed/wall-e-upscaler
- Admin: https://insta-s3-client-uploader-one.vercel.app
  Deployment `dpl_5i8CEeUkUgwm2Kruuheypf4yu9JU`.
- Future standard uploads update both root manifests, including v2 thumbnail paths
  and final dimensions. Both publishers use conditional S3 writes with conflict
  retries. The collection builder updates the session flag even when the upscaler
  already inserted the entry.
- 13 Python integration tests, eight local CloudFront route cases, three AWS-hosted
  CloudFront function cases, TypeScript checks, and the Vercel production build passed.
- Reprocessed the previously authorized Pinterest test from its retained original
  S3 version through the deployed GPU upscaler. Output:
  `pfp/pinterest_712976184805895736.jpg`, JPEG 1350 × 2400, 607,296 bytes.
  The queue completed, both manifests contain the category path, the raw input was
  removed, and exactly one wallpaper record remains (ID 22269).
- The reprocessing test used a direct Modal invocation. It does not validate a new
  URL download or the scheduled database dispatch.

## Remaining admin metadata

Four `home_sections.cover_image_url` values in separate admin project
`tbmfrcudsyoyizutxkqr` still contain the old prefix. The authenticated Supabase
account has access to Wallee (`swmhjxpiwopguxwnjbdv`) but the admin project returns
403. Its public database client cannot update these records. All four cover URLs
were checked over CloudFront and return HTTP 200 through the compatibility rewrite.
No database permissions or access policies were changed.

The exact four-row SQL update is saved privately as `admin-cover-followup.sql` in
the migration backup below. Apply it only in the admin project with an authorized
account; the statements match both the ID and old URL.

## Rollback evidence

Private backup directory (outside Git):
`/home/rdxtreme/wallee-migration-backups/category-paths-20261025-060453/`.
It contains the source/destination mapping, original S3 version IDs, verified
copies, manifest snapshots and versions, affected database rows (including
embeddings and duplicate records), reference snapshots, CloudFront configuration,
production test result, and deletion-marker receipts. Secrets are not included in
the committed report. Historical S3 versions were retained deliberately.

Restore references and objects as one coordinated operation. Do not blindly apply
old snapshots over subsequent user changes. To restore a retired object, use its
recorded source version or remove its specific migration delete marker. Database
rollback must restore both the merged records and their previous URL references.

## Queue scheduling finding

The live database has no row trigger on `upscale_queue`. Its active
`check_and_trigger_upscale` cron runs every 30 minutes; `finalize_upscale_jobs`
runs hourly and completed-job cleanup runs daily. The inspected queue functions
and cron commands do not contain the old `wallpapers/` prefix. These schedules
were not changed. The earlier short observation of a pending job does not by
itself establish that scheduled dispatch is broken.
