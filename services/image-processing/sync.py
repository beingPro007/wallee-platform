"""
Modal entrypoint to run wallpapers DB ↔ S3 sync.

The actual prune/backfill logic lives in scripts/sync_wallpapers.py. This file
just wraps it in Modal functions so it runs on Modal's infra (no local Python
env, CLIP weights already pre-cached in the upscaler image).

Usage:
  modal run sync.py::prune                   # dry-run prune
  modal run sync.py::prune --apply           # actually delete
  modal run sync.py::backfill                # dry-run backfill
  modal run sync.py::backfill --apply        # actually insert + embed
  modal run sync.py::backfill --apply --limit 20   # smoke-test first
"""
import modal
from pathlib import Path

# Slim image — only what the sync needs. No RealESRGAN / basicsr (those have
# a CUDA-nvrtc conflict and add ~5 GB of weight we'd never use here).
sync_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "supabase",
        "requests",
        "Pillow",
        "numpy<2",
        "torch==2.1.2",
        "torchvision==0.16.2",
        "open_clip_torch",
    )
    .run_commands(
        # Pre-cache CLIP weights at image-build time so the backfill function
        # doesn't redownload ~890 MB on every cold start.
        "python -c 'import open_clip; open_clip.create_model_and_transforms(\"ViT-L-14\", pretrained=\"laion2b_s32b_b82k\")'"
    )
    .add_local_dir(str(Path(__file__).resolve().parent / "scripts"), remote_path="/root/scripts", copy=True)
)

app = modal.App(
    "wall-e-sync",
    secrets=[
        # Must include SUPABASE_URL, SUPABASE_KEY (service role!),
        # CLOUDFRONT_BASE_URL. wallee-supabase-secrets already has these.
        modal.Secret.from_name("wallee-supabase-secrets"),
    ],
)


# ── prune: CPU-only, fast ─────────────────────────────────────────────────


@app.function(image=sync_image, timeout=30 * 60)
def prune(apply: bool = False, limit: int = 0) -> None:
    import sys
    sys.path.insert(0, "/root/scripts")
    from sync_wallpapers import cmd_prune
    cmd_prune(apply=apply, limit=(limit or None))


# ── backfill: GPU for CLIP encoding ───────────────────────────────────────


@app.function(image=sync_image, gpu="A10", timeout=2 * 3600)
def backfill(apply: bool = False, limit: int = 0) -> None:
    import sys
    sys.path.insert(0, "/root/scripts")
    from sync_wallpapers import cmd_backfill
    cmd_backfill(apply=apply, limit=(limit or None))


# ── local entrypoint so `modal run sync.py` invokes the right function ────


@app.local_entrypoint()
def main(cmd: str, apply: bool = False, limit: int = 0) -> None:
    """Dispatcher so the CLI reads as `modal run sync.py --cmd prune --apply`.

    Modal versions before --function targets supported a single entrypoint.
    Newer versions also support `modal run sync.py::prune --apply` directly —
    use whichever your CLI version prefers.
    """
    if cmd == "prune":
        prune.remote(apply=apply, limit=limit)
    elif cmd == "backfill":
        backfill.remote(apply=apply, limit=limit)
    else:
        raise SystemExit(f"unknown cmd: {cmd!r}. choose: prune | backfill")
