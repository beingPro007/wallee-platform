import modal
from pathlib import Path

from .config import CLASSIFIER_MODEL_NAME, CLASSIFIER_PRETRAINED

SERVICE_ROOT = Path(__file__).resolve().parents[2]

worker_data_volume = modal.Volume.from_name("wall-e-worker-data", create_if_missing=True)

# RotNet orientation detector — a self-supervised ResNet50 that predicts how many
# degrees an image is rotated from upright (0/90/180/270). Weights live in the
# `wall-e-rotnet` Volume at /models/rotnet_cc_resnet50.pt (trained on S3 wallpapers).
rotnet_volume = modal.Volume.from_name("wall-e-rotnet", create_if_missing=True)

rotnet_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("torch", "torchvision", "Pillow", "fastapi[standard]")
    .add_local_dir(str(SERVICE_ROOT / "app"), remote_path="/root/app")
)

worker_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "boto3",
        "supabase",
        "Pillow",
        "requests",
        "gallery-dl",
        "fastapi[standard]",
    )
    .add_local_dir(str(SERVICE_ROOT / "app"), remote_path="/root/app")
)

# Classifier Image
classifier_image = (
    modal.Image.debian_slim()
    .pip_install("open_clip_torch", "torch", "numpy", "pillow", "fastapi", "python-multipart", "pydantic")
    .pip_install("supabase")
    .run_commands(f"python -c 'import open_clip; open_clip.create_model_and_transforms(\"{CLASSIFIER_MODEL_NAME}\", pretrained=\"{CLASSIFIER_PRETRAINED}\")'")
    .add_local_dir(str(SERVICE_ROOT / "app"), remote_path="/root/app")
    .add_local_dir(str(SERVICE_ROOT / "embeddings"), remote_path="/root/embeddings")
)

upscaler_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "fastapi",
        "supabase",
        "numpy<2",
        "boto3",
        "torch==2.1.2",
        "torchvision==0.16.2",
        "Pillow",
        "huggingface_hub==0.20.3",
        "open_clip_torch",
    )
    .run_commands(
        # Pre-cache CLIP weights at image-build time so container cold-starts
        # don't redownload ~890 MB on every spin-up.
        f"python -c 'import open_clip; open_clip.create_model_and_transforms(\"{CLASSIFIER_MODEL_NAME}\", pretrained=\"{CLASSIFIER_PRETRAINED}\")'",
    )
    .add_local_dir(str(SERVICE_ROOT / "app"), remote_path="/root/app", copy=True)
    .add_local_dir(str(SERVICE_ROOT / "RealESRGAN/RealESRGAN"), remote_path="/root/RealESRGAN/RealESRGAN", copy=True)
    .add_local_dir(str(SERVICE_ROOT / "RealESRGAN/weights"), remote_path="/root/weights", copy=True)
)
