import modal
from fastapi import File, Form
from app.core.images import classifier_image

app = modal.App("zero-shot-classifier-api")

@app.cls(
    image=classifier_image,
    gpu="T4",
    max_containers=2,         
    scaledown_window=30,     
    secrets=[modal.Secret.from_name("wallee-supabase-secrets")]
)
class ZeroShotServiceModal:
    @modal.enter()
    def setup(self):
        from app.services.classifier import ZeroShotService
        self.service = ZeroShotService(device="cuda")

    # ── Native Modal methods (invoked in-workspace via .remote(), e.g. by the
    #    ETL worker). No public endpoint, no URL/secret plumbing. ────────────
    @modal.method()
    def classify_rpc(self, file_bytes: bytes, filename: str):
        return self.service.classify(file_bytes, filename)

    @modal.method()
    def check_duplicate_rpc(self, file_bytes: bytes, filename: str, threshold: float = 0.95):
        return self.service.check_duplicate(file_bytes, filename, threshold)

    # ── FastAPI endpoints (for external image-processing callers). ──────
    @modal.fastapi_endpoint(method="POST")
    async def classify(
        self,
        file: bytes = File(...),
        filename: str = Form(...)
    ):
        return self.service.classify(file, filename)

    @modal.fastapi_endpoint(method="POST")
    async def check_duplicate(
        self,
        file: bytes = File(...),
        filename: str = Form(...),
        threshold: float = Form(0.95),
    ):
        return self.service.check_duplicate(file, filename, threshold)
