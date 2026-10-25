"""Explicit, read-only catalog sweep. No S3/DB write credentials or schedule."""
import modal
from app.core.images import rotnet_image, rotnet_volume

app = modal.App("wall-e-catalog-orientation")
reports = modal.Volume.from_name("wall-e-catalog-orientation-reports", create_if_missing=True)


@app.cls(
    image=rotnet_image,
    gpu="T4",
    cpu=24,
    memory=32768,
    volumes={"/models": rotnet_volume, "/reports": reports},
    max_containers=1,
    scaledown_window=20,
    timeout=6 * 3600,
)
class CatalogOrientation:
    @modal.enter()
    def setup(self):
        import hashlib
        import torch
        from pathlib import Path
        from app.services.orientation import OrientationService, MODEL_PATH
        # 24 independent CPU preprocessors; avoid 24 x 24 BLAS threads.
        torch.set_num_threads(1)
        torch.set_num_interop_threads(1)
        self.service = OrientationService(device="cuda")
        self.model_sha256 = hashlib.sha256(Path(MODEL_PATH).read_bytes()).hexdigest()

    @modal.method()
    def run(self, manifest: dict, sources: list[dict]):
        import hashlib
        import io
        import json
        import re
        import time
        from collections import Counter
        from concurrent.futures import ThreadPoolExecutor
        from contextlib import nullcontext
        from pathlib import Path
        from threading import Semaphore
        from urllib.request import Request, urlopen
        from urllib.error import HTTPError
        from PIL import Image, ImageOps
        import torch
        from app.services.catalog_orientation import classify_rotation
        from app.services.orientation import ROTS

        # Some catalog PNGs are hundreds of megapixels. Bound them explicitly
        # and serialize large decodes, without rejecting legitimate 200MB files.
        Image.MAX_IMAGE_PIXELS = 512_000_000
        large_decode = Semaphore(1)

        run_id = manifest["run_id"]
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", run_id):
            raise ValueError("Invalid run id")
        threshold = manifest["threshold"]
        classify_rotation(0, 1.0, threshold)
        assert len(sources) == manifest["total"]
        assert len({s['key'] for s in sources}) == len(sources)
        # URLs expire and may be refreshed for resumption; object ETags may not change.
        identity = {"manifest": manifest, "sources": [{k: s[k] for k in ('key', 'etag')} for s in sources],
                    "model_sha256": self.model_sha256}
        digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        folder = Path('/reports') / run_id
        reports.reload()
        folder.mkdir(parents=True, exist_ok=True)
        config = folder / 'manifest.json'
        if config.exists():
            assert json.loads(config.read_text())["digest"] == digest, "Resume inputs changed"
        else:
            config.write_text(json.dumps({**identity, "digest": digest}, indent=2))
            reports.commit()

        def prepare(source):
            base = {"key": source['key'], "source_etag": source['etag']}
            if not source['etag']:
                return base, None, "missing_at_snapshot"
            for attempt in range(3):
                try:
                    # Scoped GET URLs, conditional on the exact snapshot object.
                    request = Request(source['url'], headers={"If-Match": source['etag']})
                    with urlopen(request, timeout=45) as response:
                        raw = response.read(512 * 1024 * 1024 + 1)
                    if len(raw) > 512 * 1024 * 1024:
                        return base, None, "image_exceeds_512_mib"
                    with Image.open(io.BytesIO(raw)) as image:
                        base['file_dimensions'] = list(image.size)
                        pixels = image.width * image.height
                        if pixels > 512_000_000:
                            return base, None, "image_exceeds_512_megapixels"
                        with large_decode if pixels > 64_000_000 else nullcontext():
                            base['exif_orientation'] = image.getexif().get(274, 1)
                            normalized = ImageOps.exif_transpose(image).convert('RGB')
                            base['display_dimensions'] = list(normalized.size)
                            tensor = self.service._tf(normalized)
                            normalized.close()
                    return base, tensor, None
                except HTTPError as error:
                    label = f"http_{error.code}"
                    if error.code in (403, 404, 412):
                        break
                except Exception as error:
                    # Never persist exception messages containing signed URLs.
                    label = type(error).__name__
                time.sleep(attempt + 1)
            return base, None, label

        records = {}
        for shard in sorted(folder.glob('batch-*.json')):
            for row in json.loads(shard.read_text()):
                records[row['key']] = row
        pending = [s for s in sources if s['key'] not in records or records[s['key']]['status'] == 'error']
        batch_number = len(list(folder.glob('batch-*.json')))
        started = time.time()
        with ThreadPoolExecutor(max_workers=24) as pool:
            for offset in range(0, len(pending), 96):
                prepared = list(pool.map(prepare, pending[offset:offset + 96]))
                result = []
                good = []
                for base, tensor, error in prepared:
                    if error:
                        result.append({**base, "status": "error", "error": error})
                    else:
                        good.append((base, tensor))
                for index in range(0, len(good), 24):
                    batch = good[index:index + 24]
                    inputs = torch.stack([tensor for _, tensor in batch]).to('cuda')
                    # FP32 matches the existing detector. No mixed precision threshold drift.
                    with torch.inference_mode():
                        probabilities = self.service.model(inputs).softmax(1).cpu().tolist()
                    for (base, _), probabilities_row in zip(batch, probabilities):
                        winner = max(range(4), key=probabilities_row.__getitem__)
                        result.append({**base, **classify_rotation(ROTS[winner], probabilities_row[winner], threshold),
                                       "probabilities": dict(zip(map(str, ROTS), probabilities_row))})
                for row in result:
                    records[row['key']] = row
                shard = folder / f'batch-{batch_number:06d}.json'
                shard.write_text(json.dumps(result))
                batch_number += 1
                counts = dict(Counter(row['status'] for row in records.values()))
                progress = {"run_id": run_id, "total": len(sources), "processed": len(records),
                            "counts": counts, "threshold": threshold, "elapsed_this_attempt_seconds": round(time.time() - started, 1),
                            "state": "running", "model_sha256": self.model_sha256}
                (folder / 'progress.json').write_text(json.dumps(progress, indent=2))
                reports.commit()
                print(json.dumps(progress), flush=True)
        rows = [records[s['key']] for s in sources]
        counts = dict(Counter(row['status'] for row in rows))
        summary = {"run_id": run_id, "total": len(rows), "counts": counts, "threshold": threshold,
                   "state": "completed_with_errors" if counts.get('error') else "completed",
                   "predicted_rotations": dict(Counter(str(row['pred_rotation']) for row in rows if 'pred_rotation' in row)),
                   "model_sha256": self.model_sha256, "mutated_images": 0, "upscaled_images": 0}
        (folder / 'results.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in rows))
        (folder / 'summary.json').write_text(json.dumps(summary, indent=2))
        (folder / 'progress.json').write_text(json.dumps(summary, indent=2))
        reports.commit()
        return summary
