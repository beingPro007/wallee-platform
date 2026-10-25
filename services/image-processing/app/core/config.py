import os

# Model Settings
CLASSIFIER_MODEL_NAME = "ViT-L-14"
CLASSIFIER_PRETRAINED = "laion2b_s32b_b82k"

# Upscaler Settings
UPSCALER_MODEL_WEIGHTS = "/root/weights/RealESRGAN_x2.pth"
UPSCALER_SCALE = 2
UPSCALER_BATCH_SIZE = 5
# Parallel post-processing workers (PNG encode + upload + embed) that overlap the
# GPU so it never stalls on CPU/network. Should be >= how many CPU stages fit in
# one GPU-upscale time; 3 keeps the GPU the bottleneck.
DESKTOP_POST_WORKERS = int(os.getenv("DESKTOP_POST_WORKERS", "3"))
# Concurrent GPU upscales, EACH with its own model copy (separate models are
# thread-safe; a shared model crashes). Measured ~1.22× at 2 — the win is one
# image's CPU patch-stitch overlapping another's GPU forward, not compute (the
# GPU is already saturated per image). More than ~2 gives little extra.
DESKTOP_GPU_WORKERS = int(os.getenv("DESKTOP_GPU_WORKERS", "2"))
# Patches per RealESRGAN forward pass — THE knob for GPU utilization. The model's
# default of 4 leaves an H100 ~idle (5.7s/4K); 32 hits peak (3.7s/4K) at only
# ~4GB VRAM.
UPSCALER_PATCH_BATCH = int(os.getenv("UPSCALER_PATCH_BATCH", "32"))

# Path Settings
EMBEDDINGS_DIR = "/root/embeddings"
CATEGORY_EMBEDDINGS_PATH = f"{EMBEDDINGS_DIR}/category_embeddings.npy"
CATEGORY_NAMES_PATH = f"{EMBEDDINGS_DIR}/category_names.npy"

# AWS / S3 Settings
AWS_BUCKET_NAME = os.getenv("AWS_BUCKET_NAME")

CLASSIFY_SIMILAR_THRESHOLD = 0.95

# ─────────────────────────────────────────────
# ETL Worker Settings (Instagram / Pinterest → S3 → upscale_queue)
# ─────────────────────────────────────────────
# Thumbnail generation
THUMB_WIDTH = 400
THUMB_QUALITY = 80

# De-duplication: before uploading, embed the image and query the
# `match_wallpapers` Supabase RPC; if a wallpaper already exists with
# cosine similarity > DEDUP_THRESHOLD, skip the upload entirely.
DEDUP_ENABLED = os.getenv("DEDUP_ENABLED", "1") != "0"
DEDUP_THRESHOLD = float(os.getenv("DEDUP_THRESHOLD", "0.95"))

# Desktop wallpaper detection: run the RotNet orientation detector; if an image
# is a rotated landscape (90/270 with confidence >= DESKTOP_CONFIDENCE), rotate
# it upright and treat it as a desktop-wallpaper candidate.
#
# The detector has ~90% recall but a high-confidence false-positive rate
# (~8-13% of good portraits) that a threshold can't remove — so by default
# candidates are STAGED for human review (desktop_review/ in S3), not published.
# Flip DESKTOP_AUTO_PUBLISH=1 only if you accept mis-converting some portraits.
DESKTOP_ENABLED = os.getenv("DESKTOP_ENABLED", "1") != "0"
DESKTOP_AUTO_PUBLISH = os.getenv("DESKTOP_AUTO_PUBLISH", "0") != "0"
DESKTOP_CONFIDENCE = float(os.getenv("DESKTOP_CONFIDENCE", "0.85"))

# Wallhaven source (wallhaven.cc public JSON API). API key only needed for NSFW
# or higher rate limits. Purity: 100=sfw, 010=sketchy, 001=nsfw (concatenate).
WALLHAVEN_API_KEY = os.getenv("WALLHAVEN_API_KEY")
WALLHAVEN_MAX_IMAGES = int(os.getenv("WALLHAVEN_MAX_IMAGES", "24"))
WALLHAVEN_PURITY = os.getenv("WALLHAVEN_PURITY", "100")
WALLHAVEN_SORTING = os.getenv("WALLHAVEN_SORTING", "toplist")

# Max concurrent per-image workers inside a single ETL container.
ETL_MAX_WORKERS = int(os.getenv("ETL_MAX_WORKERS", "5"))

# Persistent data dir (Modal Volume) holding Instagram cookies.
WORKER_DATA_DIR = os.getenv("WORKER_DATA_DIR", "/data")

# Accepted image mime types for upload.
VALID_IMAGE_MIMES = ("image/jpeg", "image/png", "image/webp")

# Desktop publishing is paused during the architecture reset. Phone processing stays active.
DESKTOP_PIPELINE_PAUSED = os.getenv("DESKTOP_PIPELINE_PAUSED", "1") != "0"
