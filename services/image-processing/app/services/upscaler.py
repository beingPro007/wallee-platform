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
    UPSCALER_MODEL_WEIGHTS,
    UPSCALER_DESKTOP_MODEL_WEIGHTS,  # Path to RealESRGAN_x8.pth
    AWS_BUCKET_NAME,
    UPSCALER_BATCH_SIZE,
    DESKTOP_CONCURRENCY,
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

# Tile size for tiled inference — reduce if VRAM < 8 GB
TILE_SIZE = 512
TILE_PAD  = 32


class UpscalerService:
    """
    Upscales wallpaper images using RealESRGAN.

    - Standard queue  → x4 model  → JPEG (mobile/web)
    - Desktop queue   → x8 model  → PNG  (8K lossless, then downsampled if needed)
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

        # ── Desktop model (x8, 8K) — kept for the queue-based path ────────
        self.desktop_model = RealESRGAN(self.device, scale=8)
        self.desktop_model.load_weights(UPSCALER_DESKTOP_MODEL_WEIGHTS, download=False)

        # ── CLIP image encoder (writes wallpapers.embedding for similarity)
        #    Disable via EMBED_ON_UPSCALE=0 if VRAM is tight; the dedicated
        #    backfill script will still catch up missing rows later.
        self.embed_enabled = os.getenv("EMBED_ON_UPSCALE", "1") != "0"
        self.clip_model = None
        self.clip_preprocess = None
        if self.embed_enabled:
            try:
                import open_clip
                clip_name = os.getenv("CLIP_MODEL_NAME", "ViT-L-14")
                clip_pretrained = os.getenv("CLIP_PRETRAINED", "laion2b_s32b_b82k")
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
            f"std=x{UPSCALER_SCALE} | desktop=x8 | embed={self.embed_enabled}"
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
        return f"{prefix}/{base}{ext}"

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

    async def update_manifest(self, new_keys: List[str]) -> None:
        if not new_keys:
            return
        try:
            try:
                obj  = await asyncio.to_thread(self.s3.get_object, Bucket=self.bucket_name, Key="wallpapers.json")
                data = json.loads(obj["Body"].read().decode("utf-8"))
            except Exception:
                data = {"wallpapers": []}

            current = set(data.get("wallpapers", []))
            current.update(new_keys)
            data["wallpapers"] = sorted(current)

            await asyncio.to_thread(
                self.s3.put_object,
                Bucket=self.bucket_name,
                Key="wallpapers.json",
                Body=json.dumps(data, indent=2),
                ContentType="application/json",
                CacheControl="max-age=0, no-cache, no-store",
            )
            self.logger.info(f"📄 Manifest updated: +{len(new_keys)} keys")
        except Exception as e:
            self.logger.error(f"❌ Manifest update error: {e}")

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
    # Standard queue processing  (x4, JPEG)
    # ─────────────────────────────────────────────────────────────────────

    async def _process_uuid(self, uuid: str) -> Optional[str]:
        if not uuid:
            return None
        try:
            # 1. Fetch metadata
            resp = await self._db_execute(
                self.supabase.table("upscale_queue")
                .select("raw_s3_key,category")
                .eq("id", uuid)
            )
            if not resp.data:
                self.logger.warning(f"⚠️  ID {uuid} not found in queue")
                return None

            raw_key = resp.data[0].get("raw_s3_key")
            category = resp.data[0].get("category")
            if not raw_key:
                return None

            # 2. Mark processing
            await self.execute_with_retry(
                self.supabase.table("upscale_queue").update({"status": "processing"}).eq("id", uuid),
                "Mark Processing",
            )

            # 3. Download
            self.logger.info(f"⬇️  {uuid}: {raw_key}")
            try:
                image = await self._download_image(raw_key)
            except FileNotFoundError:
                self.logger.error(f"❌ File not found: {raw_key}")
                await self.execute_with_retry(
                    self.supabase.table("upscale_queue").update({"status": "failed_missing_file"}).eq("id", uuid),
                    "Mark Missing",
                )
                return None

            # 4. Upscale (x4) — big patch batch to keep the GPU busy
            self.logger.info(f"🎨 {uuid}: Upscaling x{UPSCALER_SCALE}...")
            sr_image = await asyncio.to_thread(self.model.predict, image, UPSCALER_PATCH_BATCH)

            # 5. Upload
            out_key = self._build_output_key(raw_key, prefix="wallpapers", ext=".jpg")
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
            return out_key

        except Exception as e:
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
    # Desktop queue processing  (x8, PNG, 8K)
    # ─────────────────────────────────────────────────────────────────────

    async def _process_desktop_uuid(
        self,
        uuid: str,
        *,
        target_resolution: Tuple[int, int] = DESKTOP_TARGET_8K,
    ) -> Optional[str]:
        """
        Process a single desktop upscale job:
          1. x8 RealESRGAN  →  raw super-resolution output
          2. Lanczos downscale to target (8K / 4K) if the x8 result overshoots
          3. Save as lossless PNG  →  upload to  desktop_wallpapers/<original_name>.png
        """
        if not uuid:
            return None
        try:
            # 1. Fetch metadata
            resp = await self._db_execute(
                self.supabase.table("desktop_upscale_queue")
                .select("raw_s3_key,category")
                .eq("id", uuid)
            )
            if not resp.data:
                self.logger.warning(f"⚠️  Desktop ID {uuid} not found")
                return None

            raw_key = resp.data[0].get("raw_s3_key")
            category = resp.data[0].get("category")
            if not raw_key:
                return None

            # 2. Mark processing
            await self.execute_with_retry(
                self.supabase.table("desktop_upscale_queue").update({"status": "processing"}).eq("id", uuid),
                "Desktop Mark Processing",
            )

            # 3. Download
            self.logger.info(f"⬇️  [desktop] {uuid}: {raw_key}")
            try:
                image = await self._download_image(raw_key)
            except FileNotFoundError:
                self.logger.error(f"❌ [desktop] File not found: {raw_key}")
                await self.execute_with_retry(
                    self.supabase.table("desktop_upscale_queue")
                    .update({"status": "failed_missing_file"})
                    .eq("id", uuid),
                    "Desktop Mark Missing",
                )
                return None

            src_w, src_h = image.size
            self.logger.info(f"🖼️  Source: {src_w}×{src_h} | target: {target_resolution[0]}×{target_resolution[1]}")

            # 4. x8 Upscale  (tiled to avoid OOM on large anime artwork)
            self.logger.info(f"🎨 [desktop] {uuid}: Upscaling x8 (tile={TILE_SIZE})...")
            sr_image = await asyncio.to_thread(
                self._predict_tiled,
                self.desktop_model,
                image,
                TILE_SIZE,
                TILE_PAD,
            )

            sr_w, sr_h = sr_image.size
            self.logger.info(f"✅ x8 output: {sr_w}×{sr_h}")

            # 5. Fit to target (downscale only if over 8K)
            final_image = self._fit_to_target(sr_image, target_resolution)
            final_w, final_h = final_image.size
            self.logger.info(f"📐 Final size: {final_w}×{final_h}")

            # 6. Upload as lossless PNG
            out_key = self._build_output_key(raw_key, prefix="desktop_wallpapers", ext=".png")
            size_mb = (await self._upload_image(final_image, out_key, fmt="PNG")) / 1024 / 1024
            self.logger.info(f"⬆️  [desktop] {uuid}: {out_key}  ({size_mb:.2f} MB)")

            # 7. Mark complete
            await self.execute_with_retry(
                self.supabase.table("desktop_upscale_queue")
                .update({
                    "status": "completed",
                    "upscaled_s3_key": out_key,
                    "width": final_w,
                    "height": final_h,
                })
                .eq("id", uuid),
                "Desktop Mark Completed",
            )

            # 8. Embed + register in wallpapers table (best-effort)
            await self._embed_and_register_wallpaper(out_key, category, final_image)

            # 9. Delete raw
            await asyncio.to_thread(self.s3.delete_object, Bucket=self.bucket_name, Key=raw_key)
            return out_key

        except Exception as e:
            self.logger.error(f"❌ [desktop] Error processing {uuid}: {e}", exc_info=True)
            try:
                await self.execute_with_retry(
                    self.supabase.table("desktop_upscale_queue").update({"status": "failed"}).eq("id", uuid),
                    "Desktop Mark Failed",
                )
            except Exception:
                pass
            return None

    @staticmethod
    def _predict_tiled(
        model,
        image: Image.Image,
        tile: int = 512,
        pad: int = 32,
    ) -> Image.Image:
        """
        Run model.predict() in tiles to stay within VRAM limits.

        Each tile is padded by `pad` pixels on all sides to eliminate
        seam artifacts at tile boundaries (the padding is cropped before
        stitching back).
        """
        import numpy as np

        scale = model.scale
        w, h  = image.size
        img_np = np.array(image)

        out_h, out_w = h * scale, w * scale
        out_np = np.zeros((out_h, out_w, 3), dtype=np.uint8)

        for y in range(0, h, tile):
            for x in range(0, w, tile):
                # Source tile coords (with padding, clamped to image bounds)
                x0 = max(x - pad, 0)
                y0 = max(y - pad, 0)
                x1 = min(x + tile + pad, w)
                y1 = min(y + tile + pad, h)

                tile_img  = Image.fromarray(img_np[y0:y1, x0:x1])
                tile_sr   = model.predict(tile_img)
                tile_sr_np = np.array(tile_sr)

                # How much padding was actually added on each side?
                left_pad   = (x - x0) * scale
                top_pad    = (y - y0) * scale
                right_pad  = (x1 - min(x + tile, w)) * scale
                bottom_pad = (y1 - min(y + tile, h)) * scale

                # Crop padding from SR tile
                sr_h_tile, sr_w_tile = tile_sr_np.shape[:2]
                cropped = tile_sr_np[
                    top_pad : sr_h_tile - bottom_pad if bottom_pad else sr_h_tile,
                    left_pad : sr_w_tile - right_pad  if right_pad  else sr_w_tile,
                ]

                # Destination coords in output image
                out_x0 = x * scale
                out_y0 = y * scale
                out_x1 = out_x0 + cropped.shape[1]
                out_y1 = out_y0 + cropped.shape[0]
                out_np[out_y0:out_y1, out_x0:out_x1] = cropped

        return Image.fromarray(out_np)

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
                await self.update_manifest(successful)

        # Auto-trigger JSON build for any completed session categories
        unique_categories = set(category_map.values())
        for category in unique_categories:
            await self._maybe_trigger_json_build(category)

        self.logger.info("🏁 Standard batch finished.")

    async def upscale_for_desktop(
        self,
        ids: List[str],
        *,
        quality: str = "8k",   # "8k" | "4k"
    ) -> None:
        """
        Process a batch of desktop upscale jobs using the x8 model.

        quality="8k"  →  target 7680×4320 (PNG, lossless)
        quality="4k"  →  target 3840×2160 (PNG, lossless)
        """
        target = DESKTOP_TARGET_8K if quality == "8k" else DESKTOP_TARGET_4K
        total  = len(ids)
        self.logger.info(f"🖥️  Desktop batch: {total} jobs | target={quality.upper()} {target[0]}×{target[1]}")

        for i in range(0, total, UPSCALER_BATCH_SIZE):
            chunk = ids[i : i + UPSCALER_BATCH_SIZE]
            self.logger.info(
                f"📦 Desktop chunk {i // UPSCALER_BATCH_SIZE + 1}: "
                f"jobs {i + 1}–{i + len(chunk)} / {total}"
            )
            results = await asyncio.gather(
                *[self._process_desktop_uuid(uid, target_resolution=target) for uid in chunk],
                return_exceptions=True,
            )
            successful = [r for r in results if isinstance(r, str)]
            if successful:
                await self.update_manifest(successful)

        self.logger.info("🏁 Desktop batch finished.")

    # ─────────────────────────────────────────────────────────────────────
    # Table-free desktop upscale — driven directly by the ETL worker (no
    # desktop_upscale_queue row). Each item: {"raw_s3_key", "category"}.
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
        can run concurrently). Iterate x2 until ≥ target, then fit down. x8
        overshoots wildly (1920→15360) and wastes time; chaining x2 reaches ~8K
        fast on full-res intermediates. The model patches internally — no tiling."""
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
        if out_keys:
            await self.update_manifest(out_keys)
        self.logger.info(f"🏁 Desktop pipeline finished: {len(out_keys)}/{total} succeeded.")
        return out_keys