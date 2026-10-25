# Consolidation map

The mobile application remains a separate repository. Source imports include local uncommitted changes; original Git histories are retained in external local bundles rather than imported into the new repository's public history.

| Before (under `/home/rdxtreme`) | After (under `wallee-platform`) | Disposition |
| --- | --- | --- |
| `wallee/` | Separate mobile repo | Keep |
| `insta-s3-client-uploader/` | `apps/admin/` | Consolidated; old local folder retained |
| `walee_image_processing/` | `services/image-processing/` | Consolidated; old local folder retained |
| `wallee-search/` | `services/search-encoder/` | Consolidated; Hugging Face deployment retained |
| `wallee-supabase-proxy/` | `services/supabase-proxy/` | Consolidated; existing Worker retained |
| `walleeClassification/` | `legacy/gradio-classifier/` | Preserved; Hugging Face deployment retained |
| `wallee/supabase/migrations/` | `infra/supabase/migrations/` | Copied shared schema history; not executed |
| Uploader SQL setup script | `infra/supabase/reference/` | Preserved as reference to avoid duplicate execution |
| Real `.env*` files | Corresponding service directory | Local only; excluded from Git |
| Model weights and embeddings | Corresponding service directory | Local only; checksummed in `artifacts.json` |
| Build output, caches, editor state, `micro` binary | Not imported | Generated/unrelated files excluded |

`import-manifest.json` records original local source commit IDs. GitHub deletion is a separate final step: verify the replacement repository, remote refs, issues/releases and deployment dependencies before deleting an exact old repository. Deletion status is reported by the migration session; this table alone does not imply that any remote was deleted.

## Completion checklist

| Item | Status |
| --- | --- |
| Consolidate the five local backend/admin projects | ✓ Complete |
| Keep the Flutter mobile repository separate | ✓ Complete |
| Preserve local credentials outside Git tracking | ✓ Complete |
| Preserve model artifacts with checksums | ✓ Complete |
| Validate admin production build and TypeScript | ✓ Passed |
| Validate proxy deployment bundle without deploying | ✓ Passed |
| Initialize the new Git repository | ✓ Complete |
| Publish `beingPro007/wallee-platform` | Pending — GitHub work set aside at user request |
| Delete superseded GitHub repositories | Pending — no repositories deleted |
| Change Vercel Git integration / redeploy production | Pending — not performed by source migration |

The public repository `beingPro007/wallee-image-gen` was also discovered during the GitHub inventory. Its contents have not been imported or verified; do not delete it as part of the confirmed local-project replacement. Continue the remote inventory when GitHub work resumes.
