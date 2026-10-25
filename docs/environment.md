# Environment and credential handling

Real `.env`, `.env.local`, `.env.production`, `.dev.vars`, cookies, private keys, and service-account credentials must remain local or in the deployment provider's secret store. Root ignore rules apply at every directory depth. Placeholder-only `.env.example` files document required settings.

During migration, local environment files were copied to the matching service directory with mode `0600`; they were excluded from the new Git history. Previous Git histories are backed up outside this repository. Builds, dependency folders, model binaries, and provider link state such as `.vercel/` are excluded too.

| Runtime | Where configuration belongs |
| --- | --- |
| Admin development | `apps/admin/.env.local` (or existing `.env`) |
| Admin production | Existing Vercel project environment variables |
| Modal | `wallee-supabase-secrets` in workspace `harrir-prod-2` |
| Cloudflare | Wrangler variables/secrets or local ignored `.dev.vars` |
| Search encoder | Container environment, when required |

Only `NEXT_PUBLIC_*` variables are intended for the browser. AWS credentials, `WALLEE_SUPABASE_SERVICE_KEY`, and `BUILD_WEBHOOK_SECRET` remain server-only. The Supabase anon key is public by design; a service-role key must never replace it. The admin-auth and wallpaper database projects have separate settings and are not automatically merged.

`NEXT_PUBLIC_MODAL_INGEST_URL` is embedded at admin build time. `MODAL_APPROVE_DESKTOP_URL` is server-side. Both default to the existing `harrir-prod-2` endpoints. The build webhook secret must match between Modal and the admin deployment.

Run `make check` after staging changes. It rejects tracked environment files and common credential formats and compares tracked content against local environment credential values without printing them. This is an additional check, not a replacement for reviewing staged changes.
