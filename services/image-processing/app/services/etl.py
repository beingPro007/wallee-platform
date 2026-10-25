import os
import re
import time
import shutil
import mimetypes
import subprocess
from io import BytesIO
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Optional

from PIL import Image

from ..core.config import (
    THUMB_WIDTH,
    THUMB_QUALITY,
    DEDUP_ENABLED,
    DEDUP_THRESHOLD,
    DESKTOP_ENABLED,
    DESKTOP_AUTO_PUBLISH,
    DESKTOP_CONFIDENCE,
    WALLHAVEN_API_KEY,
    WALLHAVEN_MAX_IMAGES,
    WALLHAVEN_PURITY,
    WALLHAVEN_SORTING,
    ETL_MAX_WORKERS,
    WORKER_DATA_DIR,
    VALID_IMAGE_MIMES,
    AWS_BUCKET_NAME,
)
from ..utils.clients import get_supabase_client, get_s3_client


class ETLService:
    """
    ETL worker: pull media from Instagram / Pinterest, upload the raw image to
    S3, generate a webp thumbnail, classify it into a category (or use a fixed
    session slug), and enqueue an `upscale_queue` row.

    This mirrors the old `worker.js` (instaToS3 / ECS) but runs serverless on
    Modal. It does NOT upscale — the Supabase webhook wakes `wall-e-upscaler`
    once rows land in `upscale_queue`.
    """

    def __init__(self):
        self.s3 = get_s3_client()
        try:
            self.supabase = get_supabase_client()
        except ValueError:
            # DB is optional for a dry ETL run; uploads still work.
            self.supabase = None
        self.bucket_name = AWS_BUCKET_NAME
        self.data_dir = Path(WORKER_DATA_DIR)
        self.dedup_threshold = DEDUP_THRESHOLD
        self.dedup_enabled = DEDUP_ENABLED
        self.desktop_enabled = DESKTOP_ENABLED
        self.desktop_auto_publish = DESKTOP_AUTO_PUBLISH
        self.desktop_confidence = DESKTOP_CONFIDENCE
        self._classifier_handle = None
        self._orientation_handle = None

    def _classifier(self):
        """Lazily resolve the deployed classifier class for in-workspace
        .remote() calls (native Modal RPC — no public HTTP endpoint)."""
        if self._classifier_handle is None:
            import modal
            self._classifier_handle = modal.Cls.from_name(
                "zero-shot-classifier-api", "ZeroShotServiceModal"
            )()
        return self._classifier_handle

    def _orientation(self):
        """Lazily resolve the deployed RotNet orientation detector."""
        if self._orientation_handle is None:
            import modal
            self._orientation_handle = modal.Cls.from_name(
                "wall-e-orientation", "OrientationModal"
            )()
        return self._orientation_handle

    def _check_orientation(self, resized_bytes: bytes) -> dict:
        """Ask the RotNet detector whether this is a rotated-landscape desktop
        candidate. Fails open (not a candidate) on any error."""
        if not self.desktop_enabled:
            return {"desktop_candidate": False}
        try:
            return self._orientation().analyze_rpc.remote(
                resized_bytes, self.desktop_confidence
            ) or {"desktop_candidate": False}
        except Exception as e:
            print(f"⚠️ Orientation check failed ({e}) — treating as normal image")
            return {"desktop_candidate": False}

    @staticmethod
    def _rotate_bytes(original_bytes: bytes, fix_rotation: int) -> bytes:
        """Rotate an image to upright (fix_rotation is CCW degrees, expand=True)."""
        with Image.open(BytesIO(original_bytes)) as im:
            im = im.convert("RGB").rotate(fix_rotation, expand=True)
            buf = BytesIO()
            im.save(buf, format="JPEG", quality=95)
            return buf.getvalue()

    def _stage_desktop_review(self, rotated_bytes: bytes, category: str,
                              filename: str, ori: dict) -> str:
        """Stage a proposed desktop wallpaper (already un-rotated) under
        desktop_review/ for human approval. Rotation info lives in S3 metadata."""
        key = f"desktop_review/{category}/{filename}"
        meta = {
            "pred-rotation": str(ori.get("pred_rotation")),
            "fix-rotation": str(ori.get("fix_rotation")),
            "confidence": str(ori.get("confidence")),
        }
        self._retry_with_backoff(lambda: self.s3.put_object(
            Bucket=self.bucket_name, Key=key, Body=rotated_bytes,
            ContentType="image/jpeg", Metadata=meta))
        return key

    # ─────────────────────────────────────────────────────────────────────
    # Low-level helpers
    # ─────────────────────────────────────────────────────────────────────

    @staticmethod
    def _retry_with_backoff(fn, retries: int = 5, base_delay: float = 1.0):
        attempt = 0
        while attempt <= retries:
            try:
                return fn()
            except Exception as err:
                if attempt == retries:
                    raise err
                wait = base_delay * (2 ** attempt)
                print(f"⚠️ Attempt {attempt + 1} failed: {err}. Retrying in {wait}s...")
                time.sleep(wait)
                attempt += 1

    def _upload_to_s3(self, key: str, file_bytes: bytes, mime_type: str) -> None:
        self._retry_with_backoff(
            lambda: self.s3.put_object(
                Bucket=self.bucket_name,
                Key=key,
                Body=file_bytes,
                ContentType=mime_type,
            )
        )

    def _generate_and_upload_thumb(self, file_bytes: bytes, s3_key: str) -> Optional[str]:
        """Build a width-clamped WEBP thumbnail under thumbs/... and upload it."""
        try:
            # Strip leading prefix ("raw_images/" or "premium/") to get the sub-path
            sub_path = re.sub(r"^(raw_images|premium)/", "", s3_key)
            path_obj = Path(sub_path)
            stem = path_obj.stem
            folder = path_obj.parent

            if str(folder) == "." or not str(folder):
                thumb_key = f"thumbs/{stem}.webp"
            else:
                thumb_key = f"thumbs/{folder}/{stem}.webp"

            img = Image.open(BytesIO(file_bytes))

            # Resize without enlargement
            if img.width > THUMB_WIDTH:
                ratio = THUMB_WIDTH / float(img.width)
                new_height = int(float(img.height) * ratio)
                img = img.resize((THUMB_WIDTH, new_height), Image.Resampling.LANCZOS)

            out_buf = BytesIO()
            img.save(out_buf, format="WEBP", quality=THUMB_QUALITY)
            self._upload_to_s3(thumb_key, out_buf.getvalue(), "image/webp")
            return thumb_key
        except Exception as e:
            print(f"⚠️ Thumb generation failed: {e}")
            return None

    @staticmethod
    def _downscale_for_ai(original_bytes: bytes) -> bytes:
        """Fit inside 512×512 — a small copy used for embedding/classification."""
        try:
            with Image.open(BytesIO(original_bytes)) as img:
                img.thumbnail((512, 512), Image.Resampling.LANCZOS)
                buf = BytesIO()
                fmt = img.format if img.format else "JPEG"
                img.save(buf, format=fmt)
                return buf.getvalue()
        except Exception:
            return original_bytes

    def _check_duplicate(self, file_bytes: bytes, filename: str, mime_type: str) -> dict:
        """Ask the classifier (via native Modal .remote()) whether a
        near-identical wallpaper already exists. Fails open (not-duplicate) on
        any error so ingest is never blocked."""
        if not self.dedup_enabled:
            return {"duplicate": False}
        try:
            return self._classifier().check_duplicate_rpc.remote(
                file_bytes, filename, self.dedup_threshold
            ) or {"duplicate": False}
        except Exception as e:
            print(f"⚠️ Dedup check failed ({e}) — treating as unique")
            return {"duplicate": False}

    def _classify_image(self, file_bytes: bytes, filename: str, mime_type: str) -> str:
        """Classify via native Modal .remote() and return a category label."""
        try:
            data = self._classifier().classify_rpc.remote(file_bytes, filename)
            return (data or {}).get("label") or "misc"
        except Exception as e:
            print(f"⚠️ Classify failed ({e}) — defaulting category to 'misc'")
            return "misc"

    def _create_db_row(self, raw_s3_key: str, category: str, width: int = 0, height: int = 0) -> None:
        if not self.supabase:
            print("⚠️ Supabase client not initialized — skipping queue insert.")
            return
        try:
            self.supabase.table("upscale_queue").insert({
                "raw_s3_key": raw_s3_key,
                "category": category,
                "status": "pending",
                "upscaled_s3_key": None,
                "width": width,
                "height": height,
            }).execute()
        except Exception as err:
            print(f"DB error: {err}")

    @staticmethod
    def _safe_cleanup(dir_path: str) -> None:
        if os.path.exists(dir_path):
            try:
                shutil.rmtree(dir_path)
            except Exception:
                pass

    @staticmethod
    def _get_files_recursively(dir_path: str) -> List[str]:
        path_obj = Path(dir_path)
        if not path_obj.exists():
            return []
        return [str(p) for p in path_obj.rglob("*") if p.is_file()]

    def _valid_images(self, dir_path: str) -> List[str]:
        valid = []
        for f in self._get_files_recursively(dir_path):
            mtype, _ = mimetypes.guess_type(f)
            if mtype in VALID_IMAGE_MIMES:
                valid.append(f)
        return valid

    # ─────────────────────────────────────────────────────────────────────
    # Per-file processing
    # ─────────────────────────────────────────────────────────────────────

    def _process_file(self, original_path: str, session_slug: str, source: str = None) -> dict:
        path_obj = Path(original_path)
        filename = path_obj.name

        with open(original_path, "rb") as f:
            original_bytes = f.read()

        mime_type, _ = mimetypes.guess_type(original_path)
        if not mime_type:
            mime_type = "image/jpeg"

        width, height = 0, 0
        try:
            with Image.open(BytesIO(original_bytes)) as img:
                width, height = img.size
        except Exception:
            pass

        # A small copy reused for both dedup and (in auto mode) classification.
        resized_bytes = self._downscale_for_ai(original_bytes)

        # ── De-dup: skip before doing any S3 work if a near-identical
        #    wallpaper already exists.
        dup = self._check_duplicate(resized_bytes, filename, mime_type)
        if dup.get("duplicate"):
            sim = dup.get("similarity")
            match = dup.get("match_file_path")
            print(f"⏭️  Skipping duplicate {filename} (sim={sim} ≈ {match})")
            return {
                "status": "skipped",
                "filename": filename,
                "similarity": sim,
                "match": match,
            }

        # ── Desktop routing ──────────────────────────────────────────────
        # Wallhaven is a desktop-wallpaper source: landscape images ARE desktop
        # wallpapers already (upright, no rotation). Other sources rely on the
        # RotNet detector to catch rotated-landscapes.
        is_desktop, fix_rotation, needs_review, ori = False, 0, False, {}
        if source == "wallhaven":
            if width >= height:  # portrait Wallhaven images stay on the mobile/phone path
                is_desktop = True   # trusted landscape source → no review needed
        elif self.desktop_enabled:
            ori = self._check_orientation(resized_bytes)
            if ori.get("desktop_candidate"):
                is_desktop, fix_rotation = True, ori["fix_rotation"]
                # The RotNet detector is a strong proposer but not reliable enough
                # to auto-publish, so stage these for human review by default.
                needs_review = not self.desktop_auto_publish
                print(f"🖥️  Rotated-landscape {filename}: rotate {fix_rotation}° (conf={ori.get('confidence')})")

        if is_desktop:
            category = session_slug or "desktop"
            if fix_rotation:
                out_bytes, out_mime = self._rotate_bytes(original_bytes, fix_rotation), "image/jpeg"
            else:
                out_bytes, out_mime = original_bytes, mime_type

            if needs_review:
                review_key = self._stage_desktop_review(out_bytes, category, filename, ori)
                print(f"🖥️  Staged for review: {review_key} (conf={ori.get('confidence')})")
                return {"status": "desktop_review", "review_key": review_key}

            s3_key = f"raw_images/{category}/{filename}"
            self._upload_to_s3(s3_key, out_bytes, out_mime)
            self._generate_and_upload_thumb(out_bytes, s3_key)
            return {
                "status": "desktop",
                "raw_s3_key": s3_key,
                "category": category,
                "filename": filename,
            }

        if session_slug:
            # Premium mode: fixed category, no classification.
            category = session_slug
            s3_key = f"raw_images/{session_slug}/{filename}"
        else:
            category = self._classify_image(resized_bytes, filename, mime_type)
            s3_key = f"raw_images/{category}/{filename}"

        self._upload_to_s3(s3_key, original_bytes, mime_type)
        self._generate_and_upload_thumb(original_bytes, s3_key)
        self._create_db_row(s3_key, category, width, height)
        return {"status": "uploaded", "key": s3_key}

    def _process_directory(self, download_path: str, session_slug: str, source: str = None) -> dict:
        valid_files = self._valid_images(download_path)
        if not valid_files:
            raise Exception(f"No valid image files found in {download_path}")

        uploads: List[str] = []
        skipped: List[dict] = []
        desktop: List[dict] = []
        review: List[str] = []
        with ThreadPoolExecutor(max_workers=ETL_MAX_WORKERS) as executor:
            future_to_file = {
                executor.submit(self._process_file, f, session_slug, source): f
                for f in valid_files
            }
            for future in as_completed(future_to_file):
                f = future_to_file[future]
                try:
                    result = future.result()
                    status = result.get("status")
                    if status == "uploaded":
                        uploads.append(result["key"])
                    elif status == "skipped":
                        skipped.append(result)
                    elif status == "desktop":
                        desktop.append({"raw_s3_key": result["raw_s3_key"],
                                        "category": result["category"]})
                    elif status == "desktop_review":
                        review.append(result["review_key"])
                except Exception as e:
                    print(f"⚠️ File error processing {f}: {e}")
        return {"uploads": uploads, "skipped": skipped, "desktop": desktop, "review": review}

    def _spawn_desktop_upscale(self, desktop_items: List[dict]) -> None:
        """Fire-and-forget the 8K desktop upscale for rotated-landscape images.
        Table-free: passes the raw keys straight to the upscaler via .remote()."""
        if not desktop_items:
            return
        try:
            import modal
            up = modal.Cls.from_name("wall-e-upscaler", "UpscalerWorkerModal")()
            up.run_desktop_direct.spawn(desktop_items)
            print(f"🖥️  Spawned 8K desktop upscale for {len(desktop_items)} image(s)")
        except Exception as e:
            print(f"⚠️ Failed to spawn desktop upscale: {e}")

    # ─────────────────────────────────────────────────────────────────────
    # Downloaders
    # ─────────────────────────────────────────────────────────────────────

    @staticmethod
    def _extract_post_id(url: str) -> Optional[str]:
        match = re.search(r"/(p|reel|tv)/([A-Za-z0-9_-]+)", url)
        return match.group(2) if match else None

    def _download_instagram(self, url: str, temp_dir: Path) -> Path:
        # instaloader's post-by-shortcode fetch is currently broken by an
        # Instagram API change (BadResponseException), so use gallery-dl (kept
        # up to date) with Instagram cookies. Provide the cookies with:
        #   python3 ~/export_ig_cookies.py         # from Firefox, locally
        #   modal volume put wall-e-worker-data ~/ig_cookies.txt ig_cookies.txt
        download_path = temp_dir / "instagram"
        os.makedirs(str(download_path), exist_ok=True)

        cookies = self.data_dir / "ig_cookies.txt"
        cookie_args = ["--cookies", str(cookies)] if cookies.exists() else []

        cmd = ["gallery-dl", "-d", str(download_path)] + cookie_args + [url]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            hint = "" if cookie_args else (
                " — no Instagram cookies found; export them from your browser and "
                "upload to the 'wall-e-worker-data' volume as 'ig_cookies.txt' "
                "(Instagram requires login)"
            )
            raise Exception(f"gallery-dl (instagram) failed{hint}: {result.stderr or result.stdout}")
        return download_path

    def _download_wallhaven(self, url: str, temp_dir: Path, max_images: Optional[int] = None) -> Path:
        """Fetch wallpapers from wallhaven.cc via its JSON API. Supports a single
        wallpaper URL (/w/{id}), a tag URL (/tag/{id}), or a search URL whose
        query params are forwarded to /api/v1/search."""
        import requests
        from urllib.parse import urlparse, parse_qs

        limit = max_images or WALLHAVEN_MAX_IMAGES
        download_path = temp_dir / "wallhaven"
        os.makedirs(str(download_path), exist_ok=True)

        headers = {
            "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                           "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"),
            "Referer": "https://wallhaven.cc/",
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }
        base = {}
        if WALLHAVEN_API_KEY:
            base["apikey"] = WALLHAVEN_API_KEY

        parsed = urlparse(url)
        parts = [p for p in parsed.path.split("/") if p]
        image_urls: List[str] = []

        if len(parts) >= 2 and parts[0] == "w":
            # Single wallpaper
            res = requests.get(
                f"https://wallhaven.cc/api/v1/w/{parts[1]}",
                params=base, headers=headers, timeout=30,
            )
            res.raise_for_status()
            data = res.json().get("data", {})
            if data.get("path"):
                image_urls.append(data["path"])
        else:
            # Search / tag — forward the website's query params to the API
            q = parse_qs(parsed.query)
            params = dict(base)
            for key in ("q", "categories", "purity", "sorting", "order",
                        "topRange", "atleast", "resolutions", "ratios", "colors", "seed"):
                if key in q:
                    params[key] = q[key][0]
            params.setdefault("purity", WALLHAVEN_PURITY)
            if len(parts) >= 2 and parts[0] == "tag":
                params["q"] = f"id:{parts[1]}"
            # Only default to toplist for pure browsing — a text query with
            # sorting=toplist often returns 0 (toplist ranks a time window).
            if "q" not in params and "sorting" not in params:
                params["sorting"] = WALLHAVEN_SORTING

            page = 1
            while len(image_urls) < limit:
                params["page"] = page
                res = requests.get(
                    "https://wallhaven.cc/api/v1/search",
                    params=params, headers=headers, timeout=30,
                )
                res.raise_for_status()
                payload = res.json()
                data = payload.get("data", [])
                if not data:
                    break
                for w in data:
                    if w.get("path"):
                        image_urls.append(w["path"])
                    if len(image_urls) >= limit:
                        break
                meta = payload.get("meta", {})
                if page >= (meta.get("last_page") or page):
                    break
                page += 1
                time.sleep(1)  # respect the ~45 req/min API limit

        if not image_urls:
            raise Exception("No Wallhaven wallpapers found for URL")

        def _fetch(p):
            r = requests.get(p, headers=headers, timeout=90)
            r.raise_for_status()
            return r.content

        for p in image_urls:
            try:
                # Retry — Wallhaven's CDN rate-limits/soft-blocks bursts (403/429).
                content = self._retry_with_backoff(lambda: _fetch(p), retries=4, base_delay=2.0)
                fname = p.rstrip("/").split("/")[-1]  # e.g. wallhaven-3qrdr6.jpg
                with open(download_path / fname, "wb") as f:
                    f.write(content)
            except Exception as e:
                print(f"⚠️ Wallhaven download failed for {p}: {e}")
            time.sleep(0.4)  # be polite to the CDN

        return download_path

    def _download_pinterest(self, url: str, temp_dir: Path) -> Path:
        download_path = temp_dir / "pinterest"

        # Optional cookies from the persistent volume (helps with rate limits).
        cookies_arg = []
        cookies_file = self.data_dir / "cookies.txt"
        if cookies_file.exists():
            cookies_arg = ["--cookies", str(cookies_file)]

        cmd = ["gallery-dl"] + cookies_arg + ["-d", str(download_path), url]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise Exception(f"Gallery-dl failed: {result.stderr or result.stdout}")
        return download_path

    # ─────────────────────────────────────────────────────────────────────
    # Public entrypoint
    # ─────────────────────────────────────────────────────────────────────

    def process_url(self, url: str, session_slug: Optional[str] = None) -> dict:
        if session_slug is None:
            session_slug = os.getenv("SESSION_SLUG", "")

        temp_dir = Path("/tmp/worker_downloads")
        self._safe_cleanup(str(temp_dir))
        os.makedirs(str(temp_dir), exist_ok=True)
        start_time = time.time()

        try:
            if "instagram.com" in url:
                print(f"📸 Instagram URL detected: {url}")
                source = "instagram"
                download_path = self._download_instagram(url, temp_dir)
            elif "pinterest.com" in url or "pin.it" in url:
                print(f"📌 Pinterest URL detected: {url}")
                source = "pinterest"
                download_path = self._download_pinterest(url, temp_dir)
            elif "wallhaven.cc" in url or "whvn.cc" in url:
                print(f"🖼️ Wallhaven URL detected: {url}")
                source = "wallhaven"
                download_path = self._download_wallhaven(url, temp_dir)
            else:
                raise Exception("⚠️ URL not recognized as Instagram, Pinterest, or Wallhaven.")

            result = self._process_directory(str(download_path), session_slug, source)
            uploads = result["uploads"]
            skipped = result["skipped"]
            desktop = result["desktop"]
            review = result["review"]

            # Kick off the 8K desktop upscale for trusted desktop images
            # (wallhaven landscapes / auto-publish). Review candidates wait.
            self._spawn_desktop_upscale(desktop)

            duration = time.time() - start_time
            print(
                f"⏱️ Task completed in {duration:.2f}s — {len(uploads)} uploaded, "
                f"{len(desktop)} desktop, {len(review)} staged for review, "
                f"{len(skipped)} skipped as duplicates"
            )
            return {
                "uploads": uploads,
                "count": len(uploads),
                "desktop": desktop,
                "desktop_count": len(desktop),
                "review_count": len(review),
                "skipped": skipped,
                "skipped_count": len(skipped),
                "duration_seconds": round(duration, 2),
                "session_slug": session_slug or None,
            }
        finally:
            self._safe_cleanup(str(temp_dir))
