"""
Modal entrypoint for the orientation detector (RotNet / ResNet18).

Predicts how many degrees an image is rotated from upright and whether it's a
rotated landscape that should become an 8K desktop wallpaper. CPU-only and cheap.
Called in-workspace by the ETL worker via .remote(); also exposes an HTTP endpoint.

    modal deploy orientation.py
    curl -X POST <analyze-url> -F file=@some.jpg
"""
import modal
from fastapi import File
from app.core.images import rotnet_image, rotnet_volume

app = modal.App("wall-e-orientation")


@app.cls(
    image=rotnet_image,
    volumes={"/models": rotnet_volume},
    scaledown_window=60,
    max_containers=2,
    timeout=300,
)
class OrientationModal:
    @modal.enter()
    def setup(self):
        from app.services.orientation import OrientationService
        self.service = OrientationService(device="cpu")

    @modal.method()
    def analyze_rpc(self, image_bytes: bytes, confidence_threshold: float = 0.85):
        return self.service.analyze(image_bytes, confidence_threshold)

    @modal.fastapi_endpoint(method="POST")
    async def analyze(self, file: bytes = File(...)):
        return self.service.analyze(file)
