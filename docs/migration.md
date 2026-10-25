# Pipeline-only cleanup

| Component | Keep / remove | Reason |
| --- | --- | --- |
| Ingestion, classification, duplicate checks | ✓ Keep | Core image-processing pipeline |
| Rotation detection and desktop review routing | ✓ Keep | Correct image orientation before output |
| RealESRGAN upscaling, thumbnails, S3 output | ✓ Keep | Required final image processing |
| CLIP image encoder and category embeddings | ✓ Keep | Used by category prediction and deduplication |
| Uploader/admin interface | ✓ Keep | Starts jobs, handles review, writes session JSON to S3 |
| Pipeline database migrations and sync utilities | ✓ Keep | Queue metadata and image database maintenance |
| Standalone ONNX text encoder | ✗ Removed | Text search is outside ingestion |
| Classifier text-search endpoint and schema | ✗ Removed | No pipeline callers |
| Cloudflare Supabase proxy | ✗ Removed | Not used by the processing services |
| Earlier Gradio classifier | ✗ Removed | Separate older implementation |
| Experimental notebooks and pickle models | ✗ Removed | Not loaded by the active orientation service |
| Old `paths.npy` / `vectors.npy` indexes | ✗ Removed | Not loaded by the active classifier |
| Mobile profile, billing, favorites, and recommendation SQL | ✗ Removed | Unrelated mobile functionality |
| Historical Conda environment snapshot | ✗ Removed | Modal images declare runtime dependencies; CLI requirements cover deployment tooling |

The mobile repository and original local source folders are unchanged. Removed local files (including the encoder's ignored environment/model files) were moved to an owner-only recovery directory under `/home/rdxtreme/wallee-migration-backups/`. Initial import commit `7025f6f` also preserves the tracked source before cleanup.

`import-manifest.json` lists only the projects retained in the active tree. GitHub publication/deletion and changes to existing cloud deployments remain separate; no remote repo or deployed service is deleted by this cleanup.
