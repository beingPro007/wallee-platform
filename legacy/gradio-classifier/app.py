# app.py
from typing import List
import base64
import io
from PIL import Image
import gradio as gr
from transformers import CLIPProcessor, CLIPModel
import torch
import json

MODEL_NAME = "openai/clip-vit-large-patch14"  # change to SigLIP HF id if available
device = "cuda" if torch.cuda.is_available() else "cpu"
model = CLIPModel.from_pretrained(MODEL_NAME).to(device)
processor = CLIPProcessor.from_pretrained(MODEL_NAME)

CATEGORIES = [
    "profile-pictures",
    "space",
    "nature",
    "people",
    "animals",
    "anime",
    "cartoon",
    "superheroes",
    "marvels",
    "gods",
    "vehicles",
    "bikes",
    "cars",
    "arts",
    "objects",
    "food",
    "sports",
    "tech",
    "misc",
]

def predict_from_base64(image_b64: str) -> str:
    if image_b64.startswith("data:"):
        image_b64 = image_b64.split(",", 1)[1]
    image_bytes = base64.b64decode(image_b64)
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    inputs = processor(text=CATEGORIES, images=image, return_tensors="pt", padding=True).to(device)
    with torch.no_grad():
        image_embeds = model.get_image_features(**{k: v for k, v in inputs.items() if k.startswith("pixel_values")})
        text_embeds = model.get_text_features(input_ids=inputs["input_ids"], attention_mask=inputs["attention_mask"])
        image_embeds = image_embeds / image_embeds.norm(p=2, dim=-1, keepdim=True)
        text_embeds = text_embeds / text_embeds.norm(p=2, dim=-1, keepdim=True)
        sims = (image_embeds @ text_embeds.T).squeeze(0).cpu().numpy()
    best_idx = int(sims.argmax())
    best_label = CATEGORIES[best_idx]
    return best_label

def gradio_predict(img: Image.Image):
    buffered = io.BytesIO()
    img.convert("RGB").save(buffered, format="JPEG")
    b64 = base64.b64encode(buffered.getvalue()).decode("utf-8")
    label = predict_from_base64(b64)
    return label

title = "Zero-shot image classifier (CLIP)"
description = "Zero-shot classifier for your 19 categories. POST to /api/predict with JSON: { 'image': '<data-url-or-base64>' }"

demo = gr.Interface(
    fn=gradio_predict,
    inputs=gr.Image(type="pil"),
    outputs=gr.Textbox(),
    title=title,
    description=description,
)

if __name__ == "__main__":
    demo.launch()
