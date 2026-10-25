# Operations dashboard

Read-only admin dashboard in `apps/admin`, deployed to production on the existing Vercel project. Production URL: https://insta-s3-client-uploader-one.vercel.app. Existing processing callbacks remain for compatibility; the new dashboard exposes no processing controls.

## Data and access

Every `/api/ops/*` request validates the Supabase user on the server, requires a verified email and checks `OPS_ADMIN_EMAILS`. Empty configuration denies all access. Secrets remain server-side. Operation tables have RLS enabled and deny anonymous/authenticated table access; only the service role reads/writes telemetry. AWS collectors explicitly require the Gautam IAM identity; they do not fall back to machine credentials.

- Pipeline: Wallee Supabase summary, latest 60 operations, latest 100 queue rows. Each detail view reads the latest 250 events for its selected operation. Refresh 30 seconds; server summary cache 15 seconds.
- Library: phone entries from `wallpapers_v2.json`; desktop/review entries from actual S3 prefixes. Storage presence is distinct from publication. Missing thumbnails show a placeholder; opening an original is explicit.
- Storage: current objects only, aggregated by prefix; compares v1/v2 manifests against existing keys. Cache 15 minutes. Version history is excluded; CloudWatch storage measurements may differ.
- AWS costs: Cost Explorer daily UnblendedCost, account-wide, UTC month to date and comparable previous period. Cache 6 hours; charges can be estimated and revised. Excludes Modal, Vercel and Supabase bills.
- System: source readability, CloudFront request/error metrics, S3 daily size, live cron schedules and last result. A readable source does not establish processor health.

Required server variables: `OPS_ADMIN_EMAILS`, `WALLEE_SUPABASE_URL`, `WALLEE_SUPABASE_SERVICE_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`, `AWS_BUCKET_NAME`, `CLOUDFRONT_URL`, `CLOUDFRONT_DISTRIBUTION_ID`. Authentication also uses the existing `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Configure secrets separately for preview and production.

## Telemetry

Apply `infra/supabase/migrations/20261025070000_operations_observability.sql`, then deploy worker and upscaler. Tracking starts at deployment; historical logs are not reconstructed. Telemetry failures never abort image processing. Failed stages make the final operation partial, while fatal ingestion errors remain failed. Phone cron and direct desktop dispatch are unchanged. Run records start when a worker begins execution, not when Modal first accepts the HTTP request. Terminated containers can leave running records; timestamps remain visible. Retention is not automated yet.

## Validation and known issues (2026-10-25)

18 Python tests passed, including pipeline regression checks and telemetry failure/fallback coverage. `npm run test:access` checks the two-entry allowlist, unverified/unauthorized users and fail-closed empty configuration. Local signed-out API returned 401. Browser checks covered all six screens, mobile navigation, run timeline, gallery filters/pagination, detail dialogs and no horizontal overflow. Live collectors successfully read Supabase, S3, Cost Explorer and CloudWatch. No user password or browser session was available for a real allowed-account sign-in; users must verify that final sign-in in preview.

The live Pinterest check exposed an existing classifier registration bug: inserting `pfp/pinterest_712976184805895736.jpg` again raises PostgreSQL 23505, leading to the worker's misc fallback. The test operation is marked partial. Its new queue row `5aabe285-262c-4b8f-90ed-0cf87be3fcb0` was marked failed before dispatch to prevent publishing the incorrect category; raw test input remains for investigation, and the existing pfp output is preserved. Classification/deduplication behavior was not redesigned in this dashboard change. Future fallback events are recorded as errors and final operation status partial.

The initial inventory also reports 36 missing v1 references and 36 desktop objects outside v1; desktop has no v2 entries. These are reported for investigation, not automatically deleted or published.

## Preview delivery

Preview: https://insta-s3-client-uploader-no2ena3b8-gautam-ranas-projects.vercel.app

Deployment `dpl_3yti7RzE9xABNvRh2fzT1yt54A1k` is READY. Vercel preview protection is enabled, in addition to application authentication. At preview delivery, the production alias pointed to `dpl_GKtnqHE6zmjqHvK5JL2P1R6waRbj`. Production build and TypeScript passed; the runtime dependency audit reports zero vulnerabilities. Temporary visual-test routes were removed before building and return 404. All six local production operations endpoints return 401 when signed out; server secrets were absent from browser bundles.

Deployed preview smoke checks: sign-in returned 200; the costs API returned application-level 401 without a Supabase session, after authorized Vercel CLI access through deployment protection.

## Production delivery (2026-10-25)

User authorized full deployment. Release commit `5d5e3d6` is deployed as `dpl_AqNoUCa29w7xC7U2Uc5AxHh2rj3k`, target production, status READY. The stable production alias https://insta-s3-client-uploader-one.vercel.app is verified against the Vercel API. Production environment variables were configured explicitly with the verified Gautam identity, Wallee database, existing admin authentication project and the two approved administrator emails. Existing callback secrets were preserved.

Production smoke checks passed: `/` redirects to `/protected`, signed-out `/protected` redirects to sign-in, sign-in returns 200 with the new form, and all six operations API views return 401 with private/no-store headers without a Supabase session. Temporary test routes return 404. A browser check confirmed the deployed email/password form. Actual approved-user login still requires the user's existing credentials; no password was requested or used. The prior production deployment `dpl_GKtnqHE6zmjqHvK5JL2P1R6waRbj` remains the rollback reference. The classifier conflict documented above is not fixed by this frontend release.
