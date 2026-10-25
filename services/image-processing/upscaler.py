import modal
from fastapi import Request
from typing import List
from app.core.images import upscaler_image

app = modal.App(
    "wall-e-upscaler",
    secrets=[
        modal.Secret.from_name("wallee-supabase-secrets"), 
    ],
)

@app.cls(image=upscaler_image, gpu="H100", timeout=24 * 3600, scaledown_window=20, min_containers=0, max_containers=1)
class UpscalerWorkerModal:
    @modal.enter()
    def setup(self):
        from app.services.upscaler import UpscalerService
        self.service = UpscalerService(device="cuda")

    @modal.method()
    async def run_batch(self, ids: List[str]):
        await self.service.run_batch(ids)

    @modal.method()
    async def run_desktop_direct(self, items: List[dict], quality: str = "8k"):
        """Upscale rotated-landscape images straight to 8K desktop wallpapers.
        Called by the ETL worker via .spawn(); no queue table involved."""
        return await self.service.upscale_desktop_direct(items, quality=quality)

@app.function(image=upscaler_image)
@modal.fastapi_endpoint(method="POST")
async def approve_desktop(request: Request):
    """Human-review approval: given desktop_review/ S3 key(s), upscale them to
    8K desktop wallpapers (and the upscaler deletes the review copy). Body:
    {"keys": ["desktop_review/cat/file.jpg", ...]} or {"key": "..."}."""
    try:
        payload = await request.json()
        keys = payload.get("keys") or ([payload["key"]] if payload.get("key") else [])
        # Accept either the raw review key or a claimed desktop_pending/ key
        # (the client moves review→pending on approve so it's idempotent).
        keys = [k for k in keys if isinstance(k, str)
                and (k.startswith("desktop_review/") or k.startswith("desktop_pending/"))]
        items = []
        for k in keys:
            parts = k.split("/")
            category = parts[1] if len(parts) >= 3 else "desktop"
            items.append({"raw_s3_key": k, "category": category})
        if not items:
            return {"status": "ignored", "reason": "no valid candidate keys"}
        print(f"✅ Approving {len(items)} desktop candidate(s) → 8K upscale")
        await UpscalerWorkerModal().run_desktop_direct.spawn.aio(items)
        return {"status": "approved", "count": len(items)}
    except Exception as e:
        print(f"❌ approve_desktop error: {e}")
        return {"status": "error", "message": str(e)}


@app.function(image=upscaler_image)
@modal.fastapi_endpoint(method="POST")
async def supabase_webhook(request: Request):
    try:
        payload = await request.json()
        ids_to_process = []
        
        if isinstance(payload, list):
            for item in payload:
                if isinstance(item, str):
                    ids_to_process.append(item)
                elif isinstance(item, dict) and "id" in item:
                    ids_to_process.append(item["id"])
        elif isinstance(payload, dict):
            if "record" in payload and "id" in payload["record"]:
                ids_to_process.append(payload["record"]["id"])
            elif "id" in payload:
                ids_to_process.append(payload["id"])
            
        valid_ids = list(set(ids_to_process))
        
        if valid_ids:
            print(f"🔔 Received {len(valid_ids)} IDs. Spawning worker...")
            await UpscalerWorkerModal().run_batch.spawn.aio(valid_ids)
            return {"status": "processing_started", "count": len(valid_ids)}
            
        return {"status": "ignored", "reason": "no valid IDs found"}

    except Exception as e:
        print(f"❌ Webhook Error: {e}")
        return {"status": "error", "message": str(e)}