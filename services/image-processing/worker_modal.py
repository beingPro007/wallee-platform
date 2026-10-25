"""
Modal entrypoint for the Instagram / Pinterest ETL worker.

Replaces the old ECS `worker.js` (instaToS3). Downloads media, uploads the raw
image to S3, generates a webp thumbnail, classifies it (via the deployed
zero-shot classifier), and enqueues an `upscale_queue` row. The Supabase
webhook then wakes `wall-e-upscaler`.

Usage:
    # one-off run
    modal run worker_modal.py --url "https://www.instagram.com/p/XXXX/"
    modal run worker_modal.py --url "https://pin.it/XXXX" --session-slug my-batch

    # deploy the HTTP ingest endpoint (POST {"url": "...", "session_slug": "..."})
    modal deploy worker_modal.py
"""
import modal
from fastapi import Request

from app.core.images import worker_image, worker_data_volume
from app.core.config import WORKER_DATA_DIR

app = modal.App(
    "wall-e-worker",
    image=worker_image,
    secrets=[modal.Secret.from_name("wallee-supabase-secrets")],
)


@app.function(
    timeout=3600,  # large Wallhaven batches (up to WALLHAVEN_MAX_IMAGES) take a while
    volumes={WORKER_DATA_DIR: worker_data_volume},
)
def process_url(url: str, session_slug: str = None):
    """Run the full ETL for a single Instagram/Pinterest/Wallhaven URL."""
    from app.services.etl import ETLService
    return ETLService().process_url(url, session_slug)


@app.function(volumes={WORKER_DATA_DIR: worker_data_volume})
@modal.fastapi_endpoint(method="POST")
async def ingest(request: Request):
    """
    HTTP ingest endpoint. Accepts a single URL or a batch and spawns detached
    ETL jobs (returns immediately).

    Body: {"url": "..."} | {"url": "...", "session_slug": "..."}
          | {"urls": ["...", "..."], "session_slug": "..."}
    """
    try:
        payload = await request.json()
    except Exception:
        return {"status": "error", "message": "invalid JSON body"}

    session_slug = payload.get("session_slug") if isinstance(payload, dict) else None

    urls = []
    if isinstance(payload, dict):
        if payload.get("url"):
            urls.append(payload["url"])
        if isinstance(payload.get("urls"), list):
            urls.extend([u for u in payload["urls"] if isinstance(u, str)])
    elif isinstance(payload, list):
        urls.extend([u for u in payload if isinstance(u, str)])

    urls = [u for u in dict.fromkeys(urls) if u]  # dedupe, keep order
    if not urls:
        return {"status": "ignored", "reason": "no url(s) provided"}

    for u in urls:
        await process_url.spawn.aio(u, session_slug)

    print(f"🔔 Spawned {len(urls)} ETL job(s).")
    return {"status": "processing_started", "count": len(urls)}


@app.local_entrypoint()
def main(url: str = None, session_slug: str = None):
    import os

    target_url = url or os.getenv("TARGET_URL") or os.getenv("INSTAGRAM_URL") or os.getenv("PINTEREST_URL")
    if not target_url:
        raise Exception("No URL provided. Use --url or set TARGET_URL / INSTAGRAM_URL / PINTEREST_URL.")

    print(f"🚀 Triggering Modal ETL worker for: {target_url}")
    result = process_url.remote(target_url, session_slug)
    print("✅ Process complete. Output:", result)
