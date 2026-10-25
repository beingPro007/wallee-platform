# Home & Publishing

Open `/protected?view=home`, or choose Home & Publishing in the dashboard sidebar. Operations monitoring remains read-only; this screen restores home curation controls.

## Workflow

1. Select a section. Rename, show/hide, or change Fresh Drops, then Save settings. Up/down arrows save ordering immediately. Only one section can be Fresh Drops; turn off the previous selection before choosing another.
2. Preview build reads the existing published collection and current processed images. Review total/new/missing counts, thumbnails and saved-count discrepancies. Click a thumbnail to save it as the cover; preview again after changing settings.
3. Publish JSON updates the collection and its metadata. It preserves visibility and the chosen cover when still valid. New sections start hidden; publish images before enabling them.

Hidden sections retain images and their published catalog. This screen offers hide rather than permanent deletion. New sections use a collection ID generated from the full name and a processed image folder. Existing legacy `premium/<slug>/` sections also include canonical `<slug>/` outputs after the category migration.

## Publication implementation

`lib/home/catalog.ts` validates folders and combines existing catalog membership with actual S3 objects and durable v2 metadata. It does not read `upscale_queue`; daily queue cleanup cannot empty a collection. Missing originals are counted in the preview and omitted; missing thumbnails are reported. Empty results and malformed catalogs stop publishing.

A preview hash covers section revision, catalog ETag, resulting entries and thumbnail completeness. Publishing rechecks this hash. S3 access checks the Gautam IAM identity. The server checks database write access and changed-row results before touching S3. Each publication writes a new `sessions/<slug>/<uuid>.json` file, merges new entries into v2 with conditional writes/retries, then conditionally updates `home_sections.json_url`, count and cover. Existing master-entry flags are preserved. The app continues using its previous URL if the final metadata update fails. Unused new JSON files may remain after interrupted publication; they do not replace the active collection. Older published files are retained.

Metadata updates use the signed-in admin's Supabase session and RLS in the existing admin project. Every API request and legacy server action checks the verified-email operations allowlist. POST requests require JSON and reject a different Origin host. Edits reject a stale row revision. Reordering checks the complete ID list and attempts conditional rollback on a failure; the UI reloads actual saved state and shows an error instead of claiming success. This is not a multi-row SQL transaction because we cannot install an RPC in the separate admin project with the current credentials.

The secret-protected `/api/build-section-json` callback uses the same builder but additionally requires `ADMIN_SUPABASE_SERVICE_KEY` for that admin project. This credential is currently unavailable; it responds 503 after a valid webhook secret rather than writing a catalog and silently failing its metadata update. Manual signed-in publishing does not require this service key. No processing schedules changed.

## Validation

Publishing regression tests cover preserved membership after queue cleanup, missing originals, concurrent master writes, immutable publication, unchanged visibility, stale previews/edits, RLS-denied writes, empty/malformed catalogs, failed metadata updates, new hidden sections, unsafe folder rejection, Fresh Drops uniqueness and ordering errors. API boundary checks cover signed-out/unapproved users, cross-origin/non-JSON requests and authenticated same-origin calls.

Read-only live previews on 2026-10-25: Baki 74, Fight Club 22, Old is Gold 11, Cozy Nature 8. All existing entries were retained, with zero missing originals or thumbnails. Fight Club's metadata count is 6 while its catalog contains 22; the next successful publish will correct that count. These previews did not change the existing sections or S3 objects.

Browser checks used real preview data and simulated writes, covering sidebar navigation, build preview, publish response, rename, denied-save feedback, reordering, hidden-section creation and mobile overflow. No real administrator login/password was available for a production mutation test. Real signed-in saving/publishing is subject to the existing admin database RLS permissions.
