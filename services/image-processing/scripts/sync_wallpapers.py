#!/usr/bin/env python3
"""
sync_wallpapers.py — reconcile the `wallpapers` SQL table against the
authoritative source of truth: S3 (as projected through wallpapers_v2.json).

Two operations:

  prune     Delete DB rows whose file_path is NOT in wallpapers_v2.json.
            (~2 k rows currently — anime, pfp, arts etc. extras)

  backfill  For paths in wallpapers_v2.json missing from DB, download the
            image from CloudFront, run CLIP encode_image, INSERT.
            (~416 rows: 168 premium + 248 session-flagged + stragglers)

Default mode is --dry-run; pass --apply to actually mutate the DB.

Requires the following env vars (same as the rest of the pipeline):
  SUPABASE_URL              Wallee Supabase URL
  SUPABASE_KEY              service-role key (must bypass RLS)
  CLOUDFRONT_BASE_URL       e.g. https://d2xd8jrwaurdjd.cloudfront.net
  WALLPAPERS_V2_URL         optional; defaults to <CF>/wallpapers_v2.json

Usage:
  pip install supabase open-clip-torch torch pillow requests
  python sync_wallpapers.py prune
  python sync_wallpapers.py prune --apply
  python sync_wallpapers.py backfill
  python sync_wallpapers.py backfill --apply --limit 50
"""
from __future__ import annotations

import argparse
import io
import os
import sys
import time
from typing import Optional

import requests
from supabase import create_client, Client


# ── env ────────────────────────────────────────────────────────────────────

def _env(name: str, required: bool = True) -> Optional[str]:
    v = os.getenv(name)
    if required and not v:
        sys.exit(f"missing env var: {name}")
    return v


SUPABASE_URL = _env("SUPABASE_URL")
SUPABASE_KEY = _env("SUPABASE_KEY")
# Accept either name — Next.js admin uses CLOUDFRONT_URL; Flutter .env uses
# CLOUDFRONT_BASE_URL. Either is fine.
CF_BASE = (
    os.getenv("CLOUDFRONT_BASE_URL")
    or os.getenv("CLOUDFRONT_URL")
    or sys.exit("missing env var: CLOUDFRONT_BASE_URL or CLOUDFRONT_URL")
).rstrip("/")
V2_URL = os.getenv(
    "WALLPAPERS_V2_URL", f"{CF_BASE}/wallpapers_v2.json"
)

# CLIP encoder is only loaded on demand (backfill needs it; prune doesn't)
_clip_model = None
_clip_preprocess = None
_clip_device = None


def _load_clip():
    """Lazily load OpenCLIP — same config as classifier.py / config.py."""
    global _clip_model, _clip_preprocess, _clip_device
    if _clip_model is not None:
        return
    import torch
    import open_clip

    _clip_device = "cuda" if torch.cuda.is_available() else "cpu"
    model_name = os.getenv("CLASSIFIER_MODEL_NAME", "ViT-L-14")
    pretrained = os.getenv("CLASSIFIER_PRETRAINED", "laion2b_s32b_b82k")
    print(f"⚙️  loading {model_name}/{pretrained} on {_clip_device}…", flush=True)
    _clip_model, _, _clip_preprocess = open_clip.create_model_and_transforms(
        model_name, pretrained=pretrained
    )
    _clip_model = _clip_model.to(_clip_device).eval()
    print("✅ CLIP ready")


def _supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_KEY)


# ── shared helpers ────────────────────────────────────────────────────────


def fetch_v2_paths() -> dict[str, dict]:
    """Return {file_path: {'category': str, 'session': bool}} from v2 JSON.

    file_path = the 'p' field, normalized (no leading slash).
    category  = first path segment.
    session   = True iff entry has s == 1.
    """
    print(f"↻ fetching {V2_URL}…", flush=True)
    r = requests.get(V2_URL, timeout=60)
    r.raise_for_status()
    items = r.json().get("wallpapers", [])
    out: dict[str, dict] = {}
    for w in items:
        if isinstance(w, str):
            p, s = w, 0
        elif isinstance(w, dict):
            p, s = w.get("p", ""), int(w.get("s", 0) or 0)
        else:
            continue
        p = p.lstrip("/")
        if not p:
            continue
        category = p.split("/", 1)[0]
        out[p] = {"category": category, "session": bool(s)}
    print(f"  v2 JSON: {len(out)} unique paths")
    return out


def fetch_all_db_paths() -> set[str]:
    """Stream the wallpapers table (no embedding column) and return file_paths."""
    sb = _supabase()
    paths: set[str] = set()
    page = 0
    while True:
        # supabase-py uses 0-indexed range; .range(start, end) inclusive
        start = page * 1000
        end = start + 999
        rows = (
            sb.table("wallpapers")
            .select("file_path")
            .order("id")
            .range(start, end)
            .execute()
            .data
        )
        if not rows:
            break
        paths.update((r.get("file_path") or "").lstrip("/") for r in rows if r.get("file_path"))
        if len(rows) < 1000:
            break
        page += 1
        if page > 100:  # safety cap (100 k rows)
            print("  ⚠️ safety cap hit at page 100")
            break
    print(f"  DB:       {len(paths)} unique paths")
    return paths


# ── prune ─────────────────────────────────────────────────────────────────


def cmd_prune(apply: bool, limit: Optional[int]) -> None:
    """Delete DB rows whose file_path is not in v2 JSON."""
    v2 = fetch_v2_paths()
    db = fetch_all_db_paths()

    extras = sorted(db - v2.keys())
    if limit:
        extras = extras[:limit]
    print(f"\nDB rows NOT in v2 JSON: {len(extras)}")
    if not extras:
        print("nothing to prune.")
        return

    print("first 10 sample paths:")
    for p in extras[:10]:
        print(f"  - {p}")

    if not apply:
        print(f"\n[dry-run] would delete {len(extras)} rows. Re-run with --apply.")
        return

    sb = _supabase()
    deleted = 0
    # Delete in chunks of 500 — Supabase URL length limits make `in.()` choke
    # well before that, so we keep it conservative.
    CHUNK = 250
    for i in range(0, len(extras), CHUNK):
        batch = extras[i : i + CHUNK]
        sb.table("wallpapers").delete().in_("file_path", batch).execute()
        deleted += len(batch)
        print(f"  deleted {deleted}/{len(extras)}", flush=True)
    print(f"✅ pruned {deleted} rows")


# ── backfill ──────────────────────────────────────────────────────────────


def _encode_image(url: str) -> Optional[list[float]]:
    """Download image, run CLIP image encoder, return embedding as list[float]."""
    import torch
    from PIL import Image

    try:
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        img = Image.open(io.BytesIO(r.content)).convert("RGB")
        tensor = _clip_preprocess(img).unsqueeze(0).to(_clip_device)
        with torch.inference_mode():
            feat = _clip_model.encode_image(tensor)
            feat = feat / feat.norm(dim=-1, keepdim=True)
        return feat[0].cpu().tolist()
    except Exception as e:
        print(f"  ⚠️ encode failed: {url} → {e}")
        return None


def cmd_backfill(apply: bool, limit: Optional[int]) -> None:
    """Encode + insert v2 JSON entries that have no DB row."""
    v2 = fetch_v2_paths()
    db = fetch_all_db_paths()

    missing = sorted(set(v2.keys()) - db)
    if limit:
        missing = missing[:limit]
    print(f"\nv2 JSON paths NOT in DB: {len(missing)}")
    if not missing:
        print("nothing to backfill.")
        return

    print("first 10 sample paths:")
    for p in missing[:10]:
        print(f"  - {p}")

    if not apply:
        print(f"\n[dry-run] would encode + insert {len(missing)} rows. Re-run with --apply.")
        return

    _load_clip()
    sb = _supabase()

    inserted = failed = 0
    BATCH = 50
    pending: list[dict] = []
    t0 = time.time()

    def flush() -> None:
        nonlocal inserted, pending
        if not pending:
            return
        try:
            sb.table("wallpapers").insert(pending).execute()
            inserted += len(pending)
        except Exception as e:
            print(f"  ⚠️ batch insert failed ({len(pending)} rows): {e}")
            # fall back to single-row inserts so one bad row doesn't kill the batch
            for row in pending:
                try:
                    sb.table("wallpapers").insert(row).execute()
                    inserted += 1
                except Exception as e2:
                    print(f"    single insert failed for {row['file_path']}: {e2}")
        pending = []
        elapsed = time.time() - t0
        rate = inserted / elapsed if elapsed > 0 else 0
        print(
            f"  inserted={inserted}/{len(missing)} failed={failed} "
            f"rate={rate:.1f}/s elapsed={elapsed:.0f}s",
            flush=True,
        )

    for i, path in enumerate(missing):
        url = f"{CF_BASE}/{path}"
        emb = _encode_image(url)
        if emb is None:
            failed += 1
            continue
        pending.append(
            {
                "file_path": path,
                "category": v2[path]["category"],
                "embedding": emb,
            }
        )
        if len(pending) >= BATCH:
            flush()

    flush()
    print(f"\n✅ backfill complete. inserted={inserted} failed={failed}")


# ── cli ───────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_prune = sub.add_parser("prune", help="delete DB rows missing from v2 JSON")
    p_prune.add_argument("--apply", action="store_true", help="actually delete")
    p_prune.add_argument("--limit", type=int, default=None)

    p_back = sub.add_parser("backfill", help="encode + insert v2 JSON paths missing from DB")
    p_back.add_argument("--apply", action="store_true", help="actually insert")
    p_back.add_argument("--limit", type=int, default=None, help="cap how many rows to process")

    args = parser.parse_args()
    if args.cmd == "prune":
        cmd_prune(args.apply, args.limit)
    elif args.cmd == "backfill":
        cmd_backfill(args.apply, args.limit)


if __name__ == "__main__":
    main()
