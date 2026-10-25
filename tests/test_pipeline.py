"""Offline integration tests: real image/file handling, in-memory cloud services.

GPU inference and remote network calls are replaced at their boundaries. These
checks do not measure model accuracy or exercise the deployed Modal services.
"""
import asyncio
import importlib
import io
import json
import hashlib
import logging
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from PIL import Image
from botocore.exceptions import ClientError

SERVICE = Path(__file__).resolve().parents[1] / 'services/image-processing'
sys.path.insert(0, str(SERVICE))
from app.services.etl import ETLService

# Import orchestration without installing GPU-only dependencies. __init__ is
# bypassed below; all calls into the inference model are explicit test doubles.
with patch.dict(sys.modules, {'torch': Mock()}):
    from app.services.upscaler import UpscalerService


class MemoryS3:
    def __init__(self):
        self.objects = {}
        self.metadata = {}
        self.fail_upload = False

    def put_object(self, *, Bucket, Key, Body, **kwargs):
        current = self.objects.get(Key)
        etag = '"' + hashlib.md5(current).hexdigest() + '"' if current is not None else None
        if (kwargs.get('IfNoneMatch') == '*' and current is not None) or (
            'IfMatch' in kwargs and kwargs['IfMatch'] != etag
        ):
            raise ClientError({'Error': {'Code': 'PreconditionFailed'}}, 'PutObject')
        self.objects[Key] = Body.encode() if isinstance(Body, str) else bytes(Body)
        self.metadata[Key] = kwargs

    def get_object(self, *, Bucket, Key):
        if Key not in self.objects:
            raise ClientError({'Error': {'Code': 'NoSuchKey'}}, 'GetObject')
        return {'Body': io.BytesIO(self.objects[Key]), 'ETag': '"' + hashlib.md5(self.objects[Key]).hexdigest() + '"'}

    def download_fileobj(self, bucket, key, fileobj):
        fileobj.write(self.get_object(Bucket=bucket, Key=key)['Body'].read())

    def upload_fileobj(self, fileobj, bucket, key, ExtraArgs):
        if self.fail_upload:
            raise RuntimeError('Simulated final upload failure')
        self.put_object(Bucket=bucket, Key=key, Body=fileobj.read(), **ExtraArgs)

    def delete_object(self, *, Bucket, Key):
        del self.objects[Key]


class MemoryDB:
    def __init__(self):
        self.rows = {}

    def table(self, name):
        return Query(self.rows.setdefault(name, []))


class Query:
    def __init__(self, rows):
        self.rows = rows
        self.filters = []
        self.inserted = None
        self.updated = None

    def select(self, *args, **kwargs):
        return self

    def eq(self, key, value):
        self.filters.append(lambda row: row.get(key) == value)
        return self

    def in_(self, key, values):
        self.filters.append(lambda row: row.get(key) in values)
        return self

    def insert(self, row):
        self.inserted = dict(row)
        return self

    def update(self, row):
        self.updated = dict(row)
        return self

    def execute(self):
        if self.inserted is not None:
            self.inserted.setdefault('id', f'job-{len(self.rows) + 1}')
            self.rows.append(self.inserted)
        matches = [r for r in self.rows if all(f(r) for f in self.filters)]
        if self.updated is not None:
            for row in matches:
                row.update(self.updated)
        return SimpleNamespace(data=[dict(r) for r in matches], count=len(matches))


class PipelineTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.image = Path(tmp.name) / 'sample.jpg'
        Image.new('RGB', (600, 900), color=(20, 80, 120)).save(self.image)
        self.s3, self.db = MemoryS3(), MemoryDB()
        with patch('app.services.etl.get_s3_client', return_value=self.s3), patch(
            'app.services.etl.get_supabase_client', return_value=self.db
        ):
            self.etl = ETLService()
        self.etl.bucket_name = 'test-bucket'
        self.etl.desktop_enabled = True
        self.etl.desktop_auto_publish = False
        self.etl.dedup_enabled = True
        self.etl._classifier_handle = Mock()
        self.etl._classifier_handle.check_duplicate_rpc.remote.return_value = {'duplicate': False}
        self.etl._classifier_handle.classify_rpc.remote.return_value = {'label': 'nature'}
        self.etl._orientation_handle = Mock()
        self.etl._orientation_handle.analyze_rpc.remote.return_value = {'desktop_candidate': False}

    def ingest(self, slug='', source='instagram'):
        return self.etl._process_file(str(self.image), slug, source)

    def upscaler(self):
        service = UpscalerService.__new__(UpscalerService)
        service.s3, service.supabase = self.s3, self.db
        service.bucket_name = 'test-bucket'
        service.logger = logging.getLogger('pipeline-tests')
        service.logger.disabled = True
        service._db_lock = threading.Lock()
        service.model = Mock()
        service.model.predict.side_effect = lambda image, batch: image.resize((image.width * 2, image.height * 2))
        service._embed_and_register_wallpaper = AsyncMock()
        # The optional Vercel callback is outside this offline test.
        service._maybe_trigger_json_build = AsyncMock()
        return service

    def test_classification_upload_thumbnail_and_queue(self):
        result = self.ingest()
        self.assertEqual(result['key'], 'raw_images/nature/sample.jpg')
        self.assertEqual(self.s3.objects[result['key']], self.image.read_bytes())
        thumb = Image.open(io.BytesIO(self.s3.objects['thumbs/nature/sample.webp']))
        self.assertEqual((thumb.format, thumb.size), ('WEBP', (400, 600)))
        row = self.db.rows['upscale_queue'][0]
        self.assertEqual((row['status'], row['category'], row['width'], row['height']), ('pending', 'nature', 600, 900))
        call = self.etl._classifier_handle.classify_rpc.remote.call_args
        ai_image = Image.open(io.BytesIO(call.args[0]))
        self.assertLessEqual(max(ai_image.size), 512)

    def test_session_slug_bypasses_category_prediction(self):
        result = self.ingest('test-session')
        self.assertEqual(result['key'], 'raw_images/test-session/sample.jpg')
        self.etl._classifier_handle.classify_rpc.remote.assert_not_called()
        self.etl._classifier_handle.check_duplicate_rpc.remote.assert_called_once()

    def test_duplicate_stops_before_s3_or_queue(self):
        self.etl._classifier_handle.check_duplicate_rpc.remote.return_value = {'duplicate': True}
        self.assertEqual(self.ingest()['status'], 'skipped')
        self.assertEqual(self.s3.objects, {})
        self.assertEqual(self.db.rows, {})
        self.etl._classifier_handle.classify_rpc.remote.assert_not_called()

    def test_classifier_failure_uses_existing_misc_fallback(self):
        self.etl._classifier_handle.classify_rpc.remote.side_effect = RuntimeError('Classifier unavailable')
        self.assertEqual(self.ingest()['key'], 'raw_images/misc/sample.jpg')
        self.assertEqual(self.db.rows['upscale_queue'][0]['category'], 'misc')

    def test_wallhaven_landscape_uses_desktop_path(self):
        Image.new('RGB', (900, 600)).save(self.image)
        result = self.ingest(source='wallhaven')
        self.assertEqual(result['status'], 'desktop')
        self.assertIn('raw_images/desktop/sample.jpg', self.s3.objects)
        self.assertEqual(self.db.rows, {})
        self.etl._classifier_handle.classify_rpc.remote.assert_not_called()

    def test_rotated_candidate_is_staged_with_metadata(self):
        self.etl._orientation_handle.analyze_rpc.remote.return_value = {
            'desktop_candidate': True, 'pred_rotation': 270, 'fix_rotation': 90, 'confidence': 0.95
        }
        result = self.ingest()
        self.assertEqual(result['status'], 'desktop_review')
        key = result['review_key']
        self.assertEqual(Image.open(io.BytesIO(self.s3.objects[key])).size, (900, 600))
        self.assertEqual(self.s3.metadata[key]['Metadata']['fix-rotation'], '90')
        self.assertEqual(self.db.rows, {})

    def test_ingest_through_upscale_output_and_manifest(self):
        self.ingest()
        worker = self.upscaler()
        asyncio.run(worker.run_batch(['job-1']))
        row = self.db.rows['upscale_queue'][0]
        self.assertEqual(row['status'], 'completed')
        key = 'nature/sample.jpg'
        self.assertEqual(row['upscaled_s3_key'], key)
        self.assertEqual((row['width'], row['height']), (1200, 1800))
        image = Image.open(io.BytesIO(self.s3.objects[key]))
        self.assertEqual((image.format, image.size), ('JPEG', (1200, 1800)))
        self.assertNotIn('raw_images/nature/sample.jpg', self.s3.objects)
        self.assertIn('thumbs/nature/sample.webp', self.s3.objects)
        self.assertIn(key.encode(), self.s3.objects['wallpapers.json'])
        worker._embed_and_register_wallpaper.assert_awaited_once_with(key, 'nature', unittest.mock.ANY)
        v2 = json.loads(self.s3.objects['wallpapers_v2.json'])
        self.assertEqual(v2['wallpapers'], [{'p': key, 't': 'thumbs/nature/sample.webp', 'w': 1200, 'h': 1800}])
        self.assertFalse(any(k.startswith('wallpapers/') for k in self.s3.objects))

    def test_manifest_merge_retries_concurrent_writer_and_preserves_session_flag(self):
        worker = self.upscaler()
        self.s3.put_object(Bucket='test-bucket', Key='wallpapers_v2.json', Body=json.dumps(
            {'version': 2, 'wallpapers': [{'p': 'nature/sample.jpg', 's': 1, 'w': 1}]}
        ))
        original = self.s3.put_object
        conflict = [True]
        def concurrent_write(**kwargs):
            if conflict[0]:
                conflict[0] = False
                original(Bucket='test-bucket', Key='wallpapers_v2.json', Body=json.dumps(
                    {'version': 2, 'wallpapers': [{'p': 'nature/sample.jpg', 's': 1}, {'p': 'anime/other.jpg'}]}
                ))
            return original(**kwargs)
        with patch.object(self.s3, 'put_object', side_effect=concurrent_write):
            worker._merge_manifest('wallpapers_v2.json', [{'p': 'nature/sample.jpg', 'w': 1200}], version=2)
        data = json.loads(self.s3.objects['wallpapers_v2.json'])['wallpapers']
        self.assertEqual(data, [{'p': 'nature/sample.jpg', 's': 1, 'w': 1200}, {'p': 'anime/other.jpg'}])

    def test_failed_final_upload_preserves_original(self):
        self.ingest()
        self.s3.fail_upload = True
        result = asyncio.run(self.upscaler()._process_uuid('job-1'))
        self.assertIsNone(result)
        self.assertEqual(self.db.rows['upscale_queue'][0]['status'], 'failed')
        self.assertIn('raw_images/nature/sample.jpg', self.s3.objects)

    def test_missing_original_marks_job_failed(self):
        self.ingest()
        self.s3.objects.pop('raw_images/nature/sample.jpg')
        worker = self.upscaler()
        self.assertIsNone(asyncio.run(worker._process_uuid('job-1')))
        self.assertEqual(self.db.rows['upscale_queue'][0]['status'], 'failed_missing_file')
        worker.model.predict.assert_not_called()

    def test_direct_desktop_output_uses_x2_pipeline(self):
        for quality, target in [('4k', (900, 600)), ('8k', (1200, 800))]:
            with self.subTest(quality=quality):
                Image.new('RGB', (900, 600)).save(self.image)
                result = self.ingest(source='wallhaven')
                worker = self.upscaler()
                worker.desktop_pool = [worker.model]
                worker._free_vram = Mock()
                with patch('app.services.upscaler.DESKTOP_TARGET_4K', (900, 600)), patch(
                    'app.services.upscaler.DESKTOP_TARGET_8K', (1200, 800)
                ):
                    keys = asyncio.run(worker.upscale_desktop_direct(
                        [{'raw_s3_key': result['raw_s3_key'], 'category': 'desktop'}],
                        quality=quality,
                    ))
                self.assertEqual(keys, ['desktop_wallpapers/desktop/sample.png'])
                image = Image.open(io.BytesIO(self.s3.objects[keys[0]]))
                self.assertEqual((image.format, image.size), ('PNG', target))
                self.assertNotIn(result['raw_s3_key'], self.s3.objects)
                self.assertIn('thumbs/desktop/sample.webp', self.s3.objects)
                self.assertIn(keys[0].encode(), self.s3.objects['wallpapers.json'])
                self.assertEqual(self.db.rows, {})
                worker._embed_and_register_wallpaper.assert_awaited_once()
                if quality == '4k':
                    worker.model.predict.assert_not_called()
                else:
                    worker.model.predict.assert_called_once()

    def test_upscaler_startup_requires_only_x2_weights(self):
        created = []

        def model_factory(device, scale):
            model = Mock()
            created.append((scale, model))
            return model

        fake_model_module = SimpleNamespace(RealESRGAN=model_factory)
        with patch.dict(sys.modules, {'RealESRGAN.RealESRGAN.model': fake_model_module}), patch.dict(
            os.environ, {'EMBED_ON_UPSCALE': '0'}
        ), patch('app.services.upscaler.get_s3_client', return_value=self.s3), patch(
            'app.services.upscaler.get_supabase_client', return_value=self.db
        ):
            worker = UpscalerService()
        self.assertTrue(created)
        self.assertEqual({scale for scale, model in created}, {2})
        for scale, model in created:
            model.load_weights.assert_called_once_with('/root/weights/RealESRGAN_x2.pth', download=False)
        self.assertEqual(len(worker.desktop_pool), len(created))

    def test_remaining_modal_entrypoints_import(self):
        for name in ['main', 'worker_modal', 'orientation', 'upscaler', 'sync']:
            with self.subTest(entrypoint=name):
                importlib.import_module(name)


if __name__ == '__main__':
    unittest.main()
