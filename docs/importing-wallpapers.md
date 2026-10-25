# Import wallpapers

Production UI: `/protected?view=import`, or Import wallpapers in the sidebar.

- Automatic categories: submit a supported URL without a collection. Phone images are classified and queued for upscaling; this does not create a home section.
- Existing collection: select the collection. The server derives the ingest destination from its processed folder, including old `premium/<slug>/` compatibility. A custom section named Weekend using `anime/` imports into `anime`, not a disconnected Weekend folder.
- New home collection: enter its display name. Create the section hidden before requesting ingestion, so a failed section save never launches an untracked import. If dispatch is ambiguous, retain the draft and direct the user to activity before retrying.

After phone processing completes, use Home & Publishing → Preview build → Publish JSON → Show on home screen → Save settings. A name fixes the category; it does not force an image into phone format. There is no separate tagline field in the current `home_sections` schema. No premium tier is introduced; `premium/` is only an existing folder layout supported for old collections.

Desktop generation is paused pending a new architecture. Landscape images and detected desktop candidates are skipped before S3 upload/queueing; pause counts appear in ingestion results. Phone portrait processing continues. The desktop approval endpoint returns paused, and direct desktop upscaling rejects calls before storage writes.

`POST /api/ingest` validates the verified-email admin allowlist, same-origin requests and JSON input. It allows only HTTPS source URLs on the supported Instagram, Pinterest and Wallhaven hosts, and forwards to the fixed harrir-prod-2 worker endpoint. Accepted is distinct from completed. Network errors are reported as unconfirmed; no automatic retry risks duplicate imports. The direct existing Modal endpoint's authentication scheme was not changed.

Validation: mocked upstream tests cover destination routing, hidden creation before dispatch, denied saves, invalid URLs, missing collections and ambiguous responses; route checks cover signed-out/unapproved users and cross-origin denial. Browser tests cover all three import modes, request payloads, accepted feedback and mobile overflow. No new live scrape was submitted while restoring the UI. Python regression tests cover the desktop pause and continuing portrait ingestion.

Production deployment `dpl_Hr9uHW2SQy61VkGriAMFdHC38fS4` is READY and serves the stable production alias. Source release: `95f1842`. Signed-out import requests return 401, protected import navigation redirects to sign-in, and the temporary test page returns 404. Desktop pause status and cleaned inventory cache versions are included in this release.
