import io
from PIL import Image

# Degrees (counter-clockwise) each RotNet class corresponds to. A prediction of
# ROTS[i] means the input appears rotated that many degrees from upright, so the
# fix is to rotate by -ROTS[i].
ROTS = [0, 90, 180, 270]

# ResNet50 trained on full-res, balanced landscape+portrait data with
# center-crop preprocessing (no aspect leak). See [[orientation-detector-rotnet]].
MODEL_PATH = "/models/rotnet_cc_resnet50.pt"
INPUT_RES = 288

# Only 90/270 flip a portrait into a landscape, so only those make an image a
# desktop-wallpaper candidate. 180 confusion on busy posters is harmless.
DESKTOP_ROTATIONS = (90, 270)
DEFAULT_CONFIDENCE = 0.85


class OrientationService:
    """RotNet orientation detector. Predicts an image's rotation from upright and
    decides whether it's a rotated landscape that should become an 8K desktop
    wallpaper."""

    def __init__(self, device: str = "cpu"):
        import torch
        import torch.nn as nn
        import torchvision as tv
        from torchvision import transforms

        self.torch = torch
        self.device = device
        model = tv.models.resnet50()
        model.fc = nn.Linear(model.fc.in_features, 4)
        model.load_state_dict(torch.load(MODEL_PATH, map_location=device))
        self.model = model.to(device).eval()
        # Center-crop (matches training) — square input so orientation is judged
        # by content, not aspect ratio.
        self._tf = transforms.Compose([
            transforms.Resize(INPUT_RES),
            transforms.CenterCrop(INPUT_RES),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ])
        print("✅ RotNet (ResNet50) orientation model ready")

    def _predict(self, img: Image.Image):
        x = self._tf(img.convert("RGB")).unsqueeze(0).to(self.device)
        with self.torch.inference_mode():
            prob = self.model(x).softmax(1)[0]
        idx = int(prob.argmax())
        return ROTS[idx], float(prob[idx])

    def analyze(self, image_bytes: bytes, confidence_threshold: float = DEFAULT_CONFIDENCE) -> dict:
        """Return the predicted rotation and whether this is a rotated-landscape
        desktop candidate. Never mutates the image."""
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        w, h = img.size
        pred, conf = self._predict(img)

        # A desktop candidate is a rotated image (90/270) that, once un-rotated,
        # becomes landscape — with enough confidence to auto-act on.
        desktop_candidate = False
        fixed_dims = [w, h]
        if pred in DESKTOP_ROTATIONS and conf >= confidence_threshold:
            fw, fh = (h, w)  # a 90/270 rotation swaps width and height
            fixed_dims = [fw, fh]
            desktop_candidate = fw > fh  # upright result is landscape

        return {
            "pred_rotation": pred,          # degrees the image is rotated from upright
            "fix_rotation": -pred,          # rotate the image by this to make it upright
            "confidence": round(conf, 4),
            "file_dimensions": {"width": w, "height": h, "is_portrait_file": h > w},
            "fixed_dimensions": {"width": fixed_dims[0], "height": fixed_dims[1]},
            "desktop_candidate": desktop_candidate,
        }
