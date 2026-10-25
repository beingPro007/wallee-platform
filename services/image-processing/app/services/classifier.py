import io
import os
import torch
import numpy as np
import open_clip
from PIL import Image
from ..core.config import (
    CLASSIFIER_MODEL_NAME, 
    CLASSIFIER_PRETRAINED, 
    CATEGORY_EMBEDDINGS_PATH, 
    CATEGORY_NAMES_PATH,
    CLASSIFY_SIMILAR_THRESHOLD
)
from ..utils.clients import get_supabase_client

class ZeroShotService:
    def __init__(self, device="cuda"):
        self.device = device
        self.supabase = get_supabase_client()
        
        # Load Model
        print(f"⚙️ Loading {CLASSIFIER_MODEL_NAME}...")
        self.model, _, self.preprocess = open_clip.create_model_and_transforms(
            CLASSIFIER_MODEL_NAME, pretrained=CLASSIFIER_PRETRAINED
        )
        self.model.to(self.device).eval()

        # Load Embeddings
        self.load_embeddings()

    def load_embeddings(self):
        try:
            self.labels = np.load(CATEGORY_NAMES_PATH).tolist()
            self.text_features = torch.from_numpy(np.load(CATEGORY_EMBEDDINGS_PATH)).float().to(self.device)
            
            print(f"✅ Service Ready! Text feats: {self.text_features.dtype}")
        except FileNotFoundError as e:
            print(f"❌ Error: Category embeddings not found. {e}")
            self.text_features = None

    def classify(self, file_bytes: bytes, filename: str):
        if self.text_features is None:
            return {"error": "Embeddings not loaded."}

        # Preprocess Image
        image_pil = Image.open(io.BytesIO(file_bytes)).convert("RGB")
        image_tensor = self.preprocess(image_pil).unsqueeze(0).to(self.device)

        with torch.inference_mode():
            image_features = self.model.encode_image(image_tensor)
            image_features /= image_features.norm(dim=-1, keepdim=True)

            logit_scale = self.model.logit_scale.exp().item()
            logits = logit_scale * (image_features @ self.text_features.T)
            probs = logits.softmax(dim=-1)

            values, indices = probs[0].topk(1)
            predicted_category = self.labels[indices.item()].strip()

            clean_filename = filename.replace("temp_ai_", "").strip()
            name, _ = os.path.splitext(clean_filename)
            clean_filename = f"{name}.jpg"

            final_db_path = f"{predicted_category}/{clean_filename}"
            embedding_list = image_features[0].cpu().numpy().tolist()

            if self.is_duplicate(embedding_list):
                return {
                    "label": predicted_category,
                    "confidence": values.item(),
                    "duplicate": True,
                    "message": "Similar image already exists"
                }
                
            db_data = {
                "file_path": final_db_path, 
                "category": predicted_category,
                "embedding": embedding_list
            }

            response = self.supabase.table("wallpapers").insert(db_data).execute()
            
        return {
            "label": predicted_category,
            "confidence": values.item(),
            "db_path": final_db_path, 
            "id": response.data[0]['id'] if response.data else None
        }

    def _find_similar(self, image_embedding, threshold, exclude_file_path=""):
        """Return the closest wallpaper above `threshold` via the pgvector-backed
        `match_wallpapers` RPC, or None. Fails open (returns None) on error so
        ingest is never blocked by a DB hiccup."""
        try:
            res = self.supabase.rpc(
                "match_wallpapers",
                {
                    "query_embedding": image_embedding,
                    "match_threshold": threshold,
                    "match_count": 1,
                    "filter_file_path": exclude_file_path or "",
                    "offset_val": 0,
                },
            ).execute()
            data = res.data or []
            return data[0] if data else None
        except Exception as e:
            print(f"⚠️ match_wallpapers RPC failed (dedup skipped): {e}")
            return None

    def is_duplicate(self, image_embedding):
        match = self._find_similar(image_embedding, CLASSIFY_SIMILAR_THRESHOLD)
        if match:
            print(f"🔁 Duplicate of {match.get('file_path')} (sim={match.get('similarity')})")
            return True
        return False

    def check_duplicate(self, file_bytes: bytes, filename: str, threshold: float = None):
        """Embed an image and check the wallpapers table for a near-identical
        match. Pure read — inserts nothing. Used by the ETL worker to skip
        uploading images that already exist."""
        if threshold is None:
            threshold = CLASSIFY_SIMILAR_THRESHOLD

        image_pil = Image.open(io.BytesIO(file_bytes)).convert("RGB")
        image_tensor = self.preprocess(image_pil).unsqueeze(0).to(self.device)
        with torch.inference_mode():
            feat = self.model.encode_image(image_tensor)
            feat = feat / feat.norm(dim=-1, keepdim=True)
        embedding = feat[0].cpu().numpy().tolist()

        match = self._find_similar(embedding, threshold)
        if match:
            return {
                "duplicate": True,
                "similarity": match.get("similarity"),
                "match_file_path": match.get("file_path"),
                "category": match.get("category"),
            }
        return {"duplicate": False}