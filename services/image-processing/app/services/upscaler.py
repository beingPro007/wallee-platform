from ..utils.observability import OperationTrace
import io
import os
import json
import asyncio
import logging
import threading
import urllib.request
from typing import List, Optional, Tuple
from PIL import Image
from botocore.exceptions import ClientError
import torch

from ..core.config import (
    UPSCALER_SCALE,
    CLASSIFIER_MODEL_NAME,
    CLASSIFIER_PRETRAINED,
    UPSCALER_MODEL_WEIGHTS,
    AWS_BUCKET_NAME,
    UPSCALER_BATCH_SIZE,
    DESKTOP_POST_WORKERS,
    DESKTOP_GPU_WORKERS,
    UPSCALER_PATCH_BATCH,
)
from ..utils.clients import get_supabase_client, get_s3_client

# ─────────────────────────────────────────────
# Target resolutions for desktop (8K / 4K)
# ─────────────────────────────────────────────
DESKTOP_TARGET_8K: Tuple[int, int] = (7680, 4320)   # 8K UHD  (16:9)
DESKTOP_TARGET_4K: Tuple[int, int] = (3840, 2160)   # 4K UHD  (16:9)


class UpscalerService:
    """
    Upscales wallpaper images using RealESRGAN.

    - Standard queue → x2 model → JPEG.
    - Direct desktop jobs → repeated x2 passes → PNG fitted to 4K / 8K.
    """

    def __init__(self, device: str = "cuda"):
        self.device     = torch.device(device if torch.cuda.is_available() else "cpu")
        self.logger     = logging.getLogger("upscaler")
        self.supabase   = get_supabase_client()
        self.s3         = get_s3_client()
        self.bucket_name = AWS_BUCKET_NAME
        self._db_lock   = threading.Lock()

        from RealESRGAN.RealESRGAN.model import RealESRGAN

        # ── Standard model (x2, mobile/web + desktop iterated-x2) ─────────
        self.model = RealESRGAN(self.device, scale=UPSCALER_SCALE)
        self.model.load_weights(UPSCALER_MODEL_WEIGHTS, download=False)

        # ── Pool of x2 model copies so the desktop pipeline can upscale
        #    DESKTOP_GPU_WORKERS images concurrently (separate models are
        #    thread-safe; a shared one crashes). Weights are tiny (~64MB each).
        self.desktop_pool = [self.model]
        for _ in range(max(0, DESKTOP_GPU_WORKERS - 1)):
            extra = RealESRGAN(self.device, scale=UPSCALER_SCALE)
            extra.load_weights(UPSCALER_MODEL_WEIGHTS, download=False)
            self.desktop_pool.append(extra)

        # ── CLIP image encoder (writes wallpapers.embedding for similarity)
        #    Disable via EMBED_ON_UPSCALE=0 if VRAM is tight; the dedicated
        #    backfill script will still catch up missing rows later.
        self.embed_enabled = os.getenv("EMBED_ON_UPSCALE", "1") != "0"
        self.clip_model = None
        self.clip_preprocess = None
        if self.embed_enabled:
            try:
                import open_clip
                clip_name = os.getenv("CLIP_MODEL_NAME", CLASSIFIER_MODEL_NAME)
                clip_pretrained = os.getenv("CLIP_PRETRAINED", CLASSIFIER_PRETRAINED)
                self.logger.info(f"⚙️  Loading CLIP {clip_name}/{clip_pretrained}…")
                m, _, pp = open_clip.create_model_and_transforms(
                    clip_name, pretrained=clip_pretrained
                )
                self.clip_model = m.to(self.device).eval()
                self.clip_preprocess = pp
                self.logger.info("✅ CLIP ready (will embed every upscaled image)")
            except Exception as e:
                self.logger.error(f"⚠️ CLIP load failed — embeddings disabled: {e}")
                self.embed_enabled = False

        self.logger.info(
            f"✅ Upscaler Service Ready | device={self.device} | "
            f"std=x{UPSCALER_SCALE} | desktop=iterated-x2 | embed={self.embed_enabled}"
        )

    # ─────────────────────────────────────────────────────────────────────
    # Helpers
    # ─────────────────────────────────────────────────────────────────────

    async def _db_execute(self, query):
        """Run a postgrest query under the DB lock to prevent HTTP/2 stream conflicts."""
        def _run():
            with self._db_lock:
                return query.execute()
        return await asyncio.to_thread(_run)

    async def execute_with_retry(self, query, operation_name: str = "DB Op", max_retries: int = 3):
        for attempt in range(max_retries):
            try:
                return await self._db_execute(query)
            except Exception as e:
                if attempt < max_retries - 1:
                    await asyncio.sleep(2 ** attempt)
                else:
                    self.logger.error(f"❌ {operation_name} failed after {max_retries} attempts: {e}")
                    raise

    async def _download_image(self, s3_key: str) -> Image.Image:
        """Download an image from S3 and return a PIL Image (RGB)."""
        buf = io.BytesIO()
        try:
            await asyncio.to_thread(self.s3.download_fileobj, self.bucket_name, s3_key, buf)
        except ClientError as e:
            code = e.response["Error"]["Code"]
            if code in ("404", "NoSuchKey", "HeadObject"):
                raise FileNotFoundError(f"S3 key not found: {s3_key}") from e
            raise
        buf.seek(0)
        return Image.open(buf).convert("RGB")

    async def _upload_image(
        self,
        image: Image.Image,
        s3_key: str,
        *,
        fmt: str = "PNG",
        jpeg_quality: int = 92,
    ) -> int:
        """
        Upload a PIL Image to S3.

        Returns the byte size of the uploaded object.
        fmt: 'PNG' (lossless) | 'JPEG' (lossy)
        """
        def _encode():
            b = io.BytesIO()
            if fmt == "JPEG":
                image.save(b, format="JPEG", quality=jpeg_quality, optimize=True, subsampling=0)
                return b, "image/jpeg"
            # PNG optimize=True is brutally slow at 8K (33MP) — ~60s. compress_level=1
            # is fast and still lossless (just a slightly larger file).
            image.save(b, format="PNG", compress_level=1)
            return b, "image/png"

        # Encode off the event loop (CPU-heavy at 8K).
        buf, content_type = await asyncio.to_thread(_encode)
        size = buf.getbuffer().nbytes
        buf.seek(0)

        await asyncio.to_thread(
            self.s3.upload_fileobj,
            buf,
            self.bucket_name,
            s3_key,
            ExtraArgs={"ContentType": content_type},
        )
        return size

    @staticmethod
    def _build_output_key(raw_key: str, prefix: str, ext: str) -> str:
        """
        Convert a raw S3 key into the output key.

        raw_images/foo/bar.png  →  {prefix}/foo/bar{ext}
        anything/else/baz.webp  →  {prefix}/baz{ext}
        """
        stripped = None
        for p in ("raw_images/", "desktop_review/", "desktop_pending/"):
            if raw_key.startswith(p):
                stripped = raw_key[len(p):]
                break
        if stripped is None:
            stripped = os.path.basename(raw_key)
        base = stripped.rsplit(".", 1)[0]
        return f"{prefix}/{base}{ext}" if prefix else f"{base}{ext}"

    @staticmethod
    def _fit_to_target(image: Image.Image, target: Tuple[int, int]) -> Image.Image:
        """
        Downscale *only* if the image exceeds the target dimensions.
        Uses high-quality Lanczos resampling to preserve sharpness.
        Aspect ratio is always preserved.
        """
        tw, th = target
        w, h   = image.size
        if w <= tw and h <= th:
            return image
        ratio = min(tw / w, th / h)
        new_size = (int(w * ratio), int(h * ratio))
        return image.resize(new_size, Image.LANCZOS)

    def _merge_manifest(self, key: str, entries: list, *, version: int) -> None:
        """Merge with conditional writes so simultaneous publishers cannot lose entries."""
        for attempt in range(5):
            try:
                obj = self.s3.get_object(Bucket=self.bucket_name, Key=key)
                data = json.loads(obj["Body"].read())
                condition = {"IfMatch": obj["ETag"]}
            except ClientError as exc:
                if exc.response["Error"]["Code"] not in ("NoSuchKey", "404"):
                    raise
                data = {"wallpapers": []}
                condition = {"IfNoneMatch": "*"}
            if version == 1:
                data["wallpapers"] = sorted(set(data.get("wallpapers", [])) | set(entries))
            else:
                current = {e["p"]: e for e in data.get("wallpapers", [])}
                for entry in entries:
                    current[entry["p"]] = {**current.get(entry["p"], {}), **entry}
                data.update(version=2, wallpapers=list(current.values()))
            try:
                self.s3.put_object(
                    Bucket=self.bucket_name, Key=key,
                    Body=json.dumps(data), ContentType="application/json",
                    CacheControl="max-age=0, no-cache, no-store", **condition,
                )
                return
            except ClientError as exc:
                if exc.response["Error"]["Code"] not in (
                    "PreconditionFailed", "ConditionalRequestConflict", "412", "409"
                ) or attempt == 4:
                    raise

    async def update_manifest(self, new_keys: List[str], entries: Optional[list] = None) -> None:
        if not new_keys:
            return
        trace = await asyncio.to_thread(OperationTrace, "publish", new_keys[0])
        try:
            await asyncio.to_thread(trace.stage, "publishing", "Updating image manifests", {"images": len(new_keys), "v2": bool(entries)})
            await asyncio.to_thread(self._merge_manifest, "wallpapers.json", new_keys, version=1)
            if entries:
                await asyncio.to_thread(self._merge_manifest, "wallpapers_v2.json", entries, version=2)
            await asyncio.to_thread(trace.finish, "succeeded", "Manifest publication completed", {"images": len(new_keys), "v2": bool(entries)})
        except Exception as error:
            await asyncio.to_thread(trace.finish, "failed", "Manifest publication failed", {"error_type": type(error).__name__})
            raise
        self.logger.info(f"📄 Manifests updated: +{len(new_keys)} keys")

    # ─────────────────────────────────────────────────────────────────────
    # Embedding writer — keeps wallpapers.embedding in sync with new uploads
    # so similar-image search works without a separate backfill pass.
    # ─────────────────────────────────────────────────────────────────────

    def _encode_image_sync(self, image: Image.Image) -> list:
        """CPU/GPU CLIP encode. Returns L2-normalized 768-dim list[float]."""
        pp = self.clip_preprocess(image.convert("RGB")).unsqueeze(0).to(self.device)
        with torch.inference_mode():
            feat = self.clip_model.encode_image(pp)
            feat = feat / feat.norm(dim=-1, keepdim=True)
        return feat[0].cpu().tolist()

    async def _embed_and_register_wallpaper(
        self,
        file_path: str,
        category: Optional[str],
        image: Image.Image,
    ) -> None:
        """Encode + upsert into wallpapers table. Best-effort: any failure here
        does NOT fail the upscale job. The dedicated backfill script catches
        anything that slips through."""
        if not self.embed_enabled or self.clip_model is None:
            return
        try:
            emb = await asyncio.to_thread(self._encode_image_sync, image)
            category = category or "uncategorized"
            # Manual upsert: the wallpapers table may lack a UNIQUE(file_path)
            # constraint, so ON CONFLICT can't be used. Update if the row exists,
            # else insert.
            existing = await self._db_execute(
                self.supabase.table("wallpapers").select("id").eq("file_path", file_path).limit(1)
            )
            if existing.data:
                await self._db_execute(
                    self.supabase.table("wallpapers")
                    .update({"category": category, "embedding": emb})
                    .eq("file_path", file_path)
                )
            else:
                await self._db_execute(
                    self.supabase.table("wallpapers").insert(
                        {"file_path": file_path, "category": category, "embedding": emb}
                    )
                )
            self.logger.info(f"🧠 embedded → wallpapers: {file_path}")
        except Exception as e:
            self.logger.error(f"⚠️  embed/insert failed for {file_path}: {e}")

    # ─────────────────────────────────────────────────────────────────────
    # Standard queue processing (x2, JPEG)
    # ─────────────────────────────────────────────────────────────────────

    async def _process_uuid(self, uuid: str) -> Optional[str]:
        if not uuid:
            return None
        trace = await asyncio.to_thread(OperationTrace, "upscale", uuid)
        try:
            # 1. Fetch metadata
            resp = await self._db_execute(
                self.supabase.table("upscale_queue")
                .select("raw_s3_key,category")
                .eq("id", uuid)
            )
            if not resp.data:
                self.logger.warning(f"⚠️  ID {uuid} not found in queue")
                await asyncio.to_thread(trace.finish, "failed", "Queue record not found")
                return None

            raw_key = resp.data[0].get("raw_s3_key")
            category = resp.data[0].get("category")
            if not raw_key:
                await asyncio.to_thread(trace.finish, "failed", "Queue record has no input image")
                return None

            # 2. Mark processing
            await self.execute_with_retry(
                self.supabase.table("upscale_queue").update({"status": "processing"}).eq("id", uuid),
                "Mark Processing",
            )

            # 3. Download
            await asyncio.to_thread(trace.stage, "downloading", "Reading original image", {"key": raw_key, "category": category})
            self.logger.info(f"⬇️  {uuid}: {raw_key}")
            try:
                image = await self._download_image(raw_key)
            except FileNotFoundError:
                self.logger.error(f"❌ File not found: {raw_key}")
                await self.execute_with_retry(
                    self.supabase.table("upscale_queue").update({"status": "failed_missing_file"}).eq("id", uuid),
                    "Mark Missing",
                )
                await asyncio.to_thread(trace.finish, "failed", "Original image is missing", {"key": raw_key})
                return None

            # 4. Upscale (x2) — big patch batch to keep the GPU busy
            await asyncio.to_thread(trace.stage, "upscaling", "Upscaling on GPU", {"scale": UPSCALER_SCALE})
            self.logger.info(f"🎨 {uuid}: Upscaling x{UPSCALER_SCALE}...")
            sr_image = await asyncio.to_thread(self.model.predict, image, UPSCALER_PATCH_BATCH)

            # 5. Upload
            await asyncio.to_thread(trace.stage, "uploading", "Saving processed image")
            out_key = self._build_output_key(raw_key, prefix="", ext=".jpg")
            size_mb = (await self._upload_image(sr_image, out_key, fmt="JPEG")) / 1024 / 1024
            self.logger.info(f"⬆️  {uuid}: {out_key}  ({size_mb:.2f} MB)")

            # 6. Mark complete — store final dimensions for JSON metadata
            sr_w, sr_h = sr_image.size
            await self.execute_with_retry(
                self.supabase.table("upscale_queue")
                .update({
                    "status": "completed",
                    "upscaled_s3_key": out_key,
                    "width": sr_w,
                    "height": sr_h,
                })
                .eq("id", uuid),
                "Mark Completed",
            )

            # 7. Embed + register in wallpapers table (best-effort, non-fatal)
            await self._embed_and_register_wallpaper(out_key, category, sr_image)

            # 8. Delete raw
            await asyncio.to_thread(self.s3.delete_object, Bucket=self.bucket_name, Key=raw_key)
            await asyncio.to_thread(trace.finish, "succeeded", "Image processed; publication follows", {"key": out_key, "width": sr_w, "height": sr_h})
            return out_key

        except Exception as e:
            await asyncio.to_thread(trace.finish, "failed", "Upscaling failed; inspect service logs", {"error_type": type(e).__name__})
            self.logger.error(f"❌ Error processing {uuid}: {e}", exc_info=True)
            try:
                await self.execute_with_retry(
                    self.supabase.table("upscale_queue").update({"status": "failed"}).eq("id", uuid),
                    "Mark Failed",
                )
            except Exception:
                pass
            return None

    # ─────────────────────────────────────────────────────────────────────
    # Batch runners
    # ─────────────────────────────────────────────────────────────────────

    async def _maybe_trigger_json_build(self, category: str) -> None:
        """Call the Vercel build webhook if all images for this category are done."""
        build_url    = os.getenv("VERCEL_BUILD_URL")
        build_secret = os.getenv("BUILD_WEBHOOK_SECRET")
        if not build_url or not build_secret:
            return
        try:
            resp = await self._db_execute(
                self.supabase.table("upscale_queue")
                .select("id", count="exact")
                .eq("category", category)
                .in_("status", ["pending", "processing"])
            )
            remaining = getattr(resp, "count", None) or len(resp.data or [])
            if remaining > 0:
                self.logger.info(f"⏳ '{category}': {remaining} still pending — skipping auto-build")
                return

            self.logger.info(f"✅ '{category}': all done — triggering JSON build")

            def _post():
                req = urllib.request.Request(
                    build_url,
                    data=json.dumps({"slug": category}).encode(),
                    headers={"Content-Type": "application/json", "x-webhook-secret": build_secret},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=30) as r:
                    return r.read().decode()

            result = await asyncio.to_thread(_post)
            self.logger.info(f"🔨 Build JSON for '{category}': {result[:200]}")
        except Exception as e:
            self.logger.error(f"❌ Auto-build trigger failed for '{category}': {e}")

    async def run_batch(self, ids: List[str]) -> None:
        """Process a batch of standard (mobile/web) upscale jobs."""
        total = len(ids)
        self.logger.info(f"🚀 Standard batch: {total} jobs")

        # Fetch categories upfront so we know which sessions to check when done
        category_map: dict[str, str] = {}
        try:
            resp = await self._db_execute(
                self.supabase.table("upscale_queue")
                .select("id, category")
                .in_("id", ids)
            )
            for row in (resp.data or []):
                if row.get("category"):
                    category_map[row["id"]] = row["category"]
        except Exception as e:
            self.logger.warning(f"⚠️ Could not fetch categories for batch: {e}")

        for i in range(0, total, UPSCALER_BATCH_SIZE):
            chunk = ids[i : i + UPSCALER_BATCH_SIZE]
            self.logger.info(
                f"📦 Chunk {i // UPSCALER_BATCH_SIZE + 1}: "
                f"jobs {i + 1}–{i + len(chunk)} / {total}"
            )
            results = await asyncio.gather(
                *[self._process_uuid(uid) for uid in chunk],
                return_exceptions=True,
            )
            successful = [r for r in results if isinstance(r, str)]
            if successful:
                rows = await self._db_execute(
                    self.supabase.table("upscale_queue")
                    .select("upscaled_s3_key,width,height")
                    .in_("id", chunk).eq("status", "completed")
                )
                entries = [
                    {"p": row["upscaled_s3_key"],
                     "t": "thumbs/" + row["upscaled_s3_key"].rsplit(".", 1)[0] + ".webp",
                     "w": row.get("width", 0), "h": row.get("height", 0)}
                    for row in rows.data if row.get("upscaled_s3_key") in successful
                ]
                await self.update_manifest(successful, entries)

        # Auto-trigger JSON build for any completed session categories
        unique_categories = set(category_map.values())
        for category in unique_categories:
            await self._maybe_trigger_json_build(category)

        self.logger.info("🏁 Standard batch finished.")

    # ─────────────────────────────────────────────────────────────────────
    # Direct desktop upscale, driven by the ETL worker.
    # Each item: {"raw_s3_key", "category"}.
    # ─────────────────────────────────────────────────────────────────────

    def _free_vram(self) -> None:
        """Release cached GPU memory between heavy 8K jobs to avoid OOM."""
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    async def _upload_thumb(self, image: Image.Image, out_key: str, width: int = 400) -> Optional[str]:
        """Generate a width-clamped webp thumbnail for a desktop wallpaper and
        upload it under thumbs/{category}/{stem}.webp — matching the mobile
        thumb convention so the app grid can render it."""
        try:
            sub = out_key.split("/", 1)[1] if "/" in out_key else out_key  # {cat}/{stem}.png
            stem_path = sub.rsplit(".", 1)[0]                              # {cat}/{stem}
            thumb_key = f"thumbs/{stem_path}.webp"
            thumb = image.convert("RGB")
            if thumb.width > width:
                ratio = width / thumb.width
                thumb = thumb.resize((width, int(thumb.height * ratio)), Image.LANCZOS)
            buf = io.BytesIO()
            thumb.save(buf, format="WEBP", quality=80)
            await asyncio.to_thread(
                self.s3.put_object, Bucket=self.bucket_name, Key=thumb_key,
                Body=buf.getvalue(), ContentType="image/webp",
            )
            self.logger.info(f"🖼️  thumb → {thumb_key}")
            return thumb_key
        except Exception as e:
            self.logger.error(f"⚠️ desktop thumb failed for {out_key}: {e}")
            return None

    def _upscale_to_target(self, model, image: Image.Image, target: Tuple[int, int]) -> Image.Image:
        """GPU stage (runs in a worker thread using its OWN model copy, so several
        can run concurrently). Repeat x2 until the target is reached, then fit
        down while preserving the aspect ratio. The model handles its own patches."""
        tw, th = target
        if image.width >= tw and image.height >= th:
            return self._fit_to_target(image, target)
        cur = image
        passes = 0
        while (cur.width < tw or cur.height < th) and passes < 4:
            cur = model.predict(cur, UPSCALER_PATCH_BATCH)
            passes += 1
        final = self._fit_to_target(cur, target)
        self.logger.info(f"   x2×{passes}: {image.size} → {cur.size} → fit {final.size}")
        return final

    async def _finalize_desktop(self, final_image: Image.Image, raw_key: str,
                                category: Optional[str]) -> Optional[str]:
        """Post stage: encode PNG + upload + thumb + embed + delete raw. Touches
        no model, so it runs concurrently with the GPU — the GPU never waits on it."""
        try:
            out_key = self._build_output_key(raw_key, prefix="desktop_wallpapers", ext=".png")
            size_mb = (await self._upload_image(final_image, out_key, fmt="PNG")) / 1024 / 1024
            self.logger.info(f"⬆️  [desktop] {out_key} ({size_mb:.2f} MB)")
            await self._upload_thumb(final_image, out_key)
            await self._embed_and_register_wallpaper(out_key, category, final_image)
            await asyncio.to_thread(self.s3.delete_object, Bucket=self.bucket_name, Key=raw_key)
            return out_key
        except Exception as e:
            self.logger.error(f"❌ [desktop] finalize failed {raw_key}: {e}", exc_info=True)
            return None

    async def upscale_desktop_direct(self, items: List[dict], *, quality: str = "8k") -> List[str]:
        """3-stage pipeline so nothing stalls the GPUs:
            downloader → N GPU workers (own model each) → M post workers.
        Downloads run ahead into a queue; each GPU worker upscales with its own
        model copy (so several run concurrently — one image's CPU patch-stitch
        overlaps another's GPU forward); post workers encode/upload/embed."""
        trace = await asyncio.to_thread(OperationTrace, "desktop", items[0].get("raw_s3_key") if items else None)
        await asyncio.to_thread(trace.stage, "upscaling", "Desktop processing started", {"images": len(items), "quality": quality})
        target = DESKTOP_TARGET_8K if quality == "8k" else DESKTOP_TARGET_4K
        total = len(items)
        n_gpu = min(DESKTOP_GPU_WORKERS, len(self.desktop_pool))
        self.logger.info(
            f"🖥️  Desktop pipeline: {total} image(s) | target={quality.upper()} "
            f"| gpu_workers={n_gpu} | post_workers={DESKTOP_POST_WORKERS}"
        )
        out_keys: List[str] = []
        gpu_q: asyncio.Queue = asyncio.Queue(maxsize=n_gpu + 2)
        post_q: asyncio.Queue = asyncio.Queue(maxsize=DESKTOP_POST_WORKERS + 2)

        async def downloader():
            for it in items:
                try:
                    img = await self._download_image(it["raw_s3_key"])
                    await gpu_q.put((img, it))
                except Exception as e:
                    self.logger.error(f"❌ [desktop] download failed {it['raw_s3_key']}: {e}")
            for _ in range(n_gpu):
                await gpu_q.put(None)

        async def gpu_worker(model):
            while True:
                job = await gpu_q.get()
                if job is None:
                    break
                img, it = job
                try:
                    final = await asyncio.to_thread(self._upscale_to_target, model, img, target)
                    await post_q.put((final, it["raw_s3_key"], it.get("category")))
                except Exception as e:
                    self.logger.error(f"❌ [desktop] upscale failed {it['raw_s3_key']}: {e}", exc_info=True)
            self._free_vram()

        async def post_worker():
            while True:
                job = await post_q.get()
                if job is None:
                    break
                final, raw_key, cat = job
                key = await self._finalize_desktop(final, raw_key, cat)
                if key:
                    out_keys.append(key)
                    await asyncio.to_thread(trace.stage, "uploading", "Desktop image saved", {"key": key, "width": final.width, "height": final.height})

        gpu_tasks = [asyncio.create_task(gpu_worker(self.desktop_pool[i])) for i in range(n_gpu)]

        async def gpu_coordinator():
            await asyncio.gather(*gpu_tasks)
            for _ in range(DESKTOP_POST_WORKERS):
                await post_q.put(None)

        await asyncio.gather(
            downloader(),
            gpu_coordinator(),
            *[post_worker() for _ in range(DESKTOP_POST_WORKERS)],
        )
        try:
            if out_keys:
                await self.update_manifest(out_keys)
            await asyncio.to_thread(trace.finish, "succeeded" if len(out_keys) == total else "partial" if out_keys else "failed", "Desktop batch finished", {"completed": len(out_keys), "total": total, "failed": total - len(out_keys)})
        except Exception as error:
            await asyncio.to_thread(trace.finish, "failed", "Desktop publication failed", {"error_type": type(error).__name__, "completed": len(out_keys), "total": total})
            raise
        self.logger.info(f"🏁 Desktop pipeline finished: {len(out_keys)}/{total} succeeded.")
        return out_keys