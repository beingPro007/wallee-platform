# Migration validation

Validated during the local consolidation on 2026-10-25:

- Admin dependency installation from the consolidated manifest and lockfile.
- Admin TypeScript check (`npm run typecheck`).
- Admin production build (`npm run build`), using placeholder Supabase values with real local environment files temporarily isolated and then restored. No live database test was performed.
- Cloudflare Worker bundle (`wrangler deploy --dry-run`); no deployment performed.
- Python syntax and JSON parsing for tracked source files.
- Credential patterns and exact local environment credential values checked against tracked content; no matches found.
- Real environment files excluded from Git, copied byte-for-byte, and set to mode `0600`.
- Model artifact sizes/checksums recorded and verified.
- Modal local source paths checked from an unrelated working directory.
- Original repository Git bundles created and verified outside the new repository.

The Next.js build reports inherited middleware-convention and browser-mapping-age warnings. Existing source files also contain inherited whitespace warnings. These did not prevent compilation or the production build.

GPU inference, live Supabase webhooks, database migration execution, Vercel Git integration, and production deployments were not exercised by this source migration. GitHub publication/deletion was set aside at the user's request and remains a separate pending step.
