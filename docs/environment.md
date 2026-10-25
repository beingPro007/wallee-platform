# Environment and credentials

Real `.env`, `.env.local`, cookies, private keys, and provider credentials remain local or in the deployment provider's secret store. Root ignore rules apply at every depth. Only placeholder `.env.example` files belong in Git.

| Runtime | Configuration |
| --- | --- |
| Pipeline development and maintenance | `services/image-processing/.env` when explicitly loaded by a local tool |
| Modal pipeline | Existing `wallee-supabase-secrets` in `harrir-prod-2` |
| Uploader development | `apps/admin/.env` and `.env.local` |
| Uploader production | Existing Vercel project variables |

Copied local environment files retain mode `0600`. The removed encoder's local environment is in the external recovery backup rather than in the active repository. The cleanup does not rewrite existing secret values.

Only `NEXT_PUBLIC_*` settings are intended for browser exposure. AWS credentials, `WALLEE_SUPABASE_SERVICE_KEY`, and `BUILD_WEBHOOK_SECRET` remain server-only. Admin-auth and wallpaper database settings can refer to different Supabase projects; do not combine them inadvertently.

`NEXT_PUBLIC_MODAL_INGEST_URL` is embedded at UI build time. `MODAL_APPROVE_DESKTOP_URL` is server-side. Both default to the existing `harrir-prod-2` endpoints. The build webhook secret must match between Modal and the uploader deployment.

The inherited processor `.env` keys were corrected from `SUPABSE_URL` / `SUPABASE_SERVICE_KEY` to the runtime names `SUPABASE_URL` / `SUPABASE_KEY`, preserving their values and an external backup. Existing Modal execution uses its named secret and does not automatically load this local file.

Run `make check` after staging changes. It rejects tracked environment files and common credential patterns and compares tracked content with local environment credential values without displaying them.
