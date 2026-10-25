import importlib.util
import csv
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/image-processing'))
from app.services.catalog_orientation import classify_rotation

spec = importlib.util.spec_from_file_location('catalog_cli', ROOT / 'scripts/catalog_orientation.py')
catalog_cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog_cli)


class CatalogOrientationTests(unittest.TestCase):
    def test_low_confidence_rotation_never_qualifies(self):
        for rotation in (0, 90, 180, 270):
            result = classify_rotation(rotation, 0.949999)
            self.assertEqual(result['status'], 'skipped')
            self.assertFalse(result['rotation_candidate'])
            self.assertEqual(result['suggested_fix_rotation'], 0)

    def test_all_rotations_including_180(self):
        for rotation in (90, 180, 270):
            result = classify_rotation(rotation, 0.950001)
            self.assertEqual(result['status'], 'rotation_candidate')
            self.assertEqual(result['suggested_fix_rotation'], -rotation)
        self.assertEqual(classify_rotation(0, 0.99)['status'], 'upright')

    def test_exact_threshold_is_skipped(self):
        for rotation in (0, 90, 180, 270):
            result = classify_rotation(rotation, 0.95)
            self.assertEqual(result['status'], 'skipped')
            self.assertFalse(result['rotation_candidate'])
            self.assertEqual(result['suggested_fix_rotation'], 0)

    def test_invalid_prediction_rejected(self):
        for confidence in (float('nan'), float('inf'), -1, 2):
            with self.assertRaises(ValueError):
                classify_rotation(90, confidence)

    def test_catalog_union_preserves_entries_not_in_v2(self):
        old = catalog_cli.catalog_paths({'wallpapers': ['anime/a.jpg', 'anime/b.jpg']})
        new = catalog_cli.catalog_paths({'wallpapers': [{'p': 'anime/a.jpg'}, {'p': 'art/c.png'}]})
        self.assertEqual(old | new, {'anime/a.jpg', 'anime/b.jpg', 'art/c.png'})

    def test_unknown_entries_fail_instead_of_silently_skipping(self):
        with self.assertRaises(ValueError):
            catalog_cli.catalog_paths({'wallpapers': [{'unexpected': 'anime/a.jpg'}]})

    def test_export_reselects_old_scores_without_a_review_list(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            rows = []
            for key, prediction, confidence in [('upright.jpg', 0, .99), ('boundary.jpg', 90, .95),
                                                ('selected.jpg', 90, .951), ('low.jpg', 90, .8)]:
                rows.append({'key': key, 'source_etag': key, 'status': 'uncertain',
                             'pred_rotation': prediction, 'confidence': confidence,
                             'probabilities': {str(prediction): confidence, '180': 1-confidence}})
            rows.append({'key': 'broken.jpg', 'source_etag': 'broken.jpg', 'status': 'error'})
            (folder / 'remote-results.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
            (folder / 'sources.json').write_text(json.dumps([{'key': r['key'], 'etag': r['source_etag']} for r in rows]))
            (folder / 'manifest.json').write_text(json.dumps({'threshold': .95}))
            (folder / 'remote-summary.json').write_text('{}')
            (folder / 'uncertain.csv').write_text('obsolete review list')
            catalog_cli.export_results(folder)
            self.assertFalse((folder / 'uncertain.csv').exists())
            with (folder / 'rotation-candidates.csv').open() as stream:
                selected = list(csv.DictReader(stream))
            self.assertEqual([r['key'] for r in selected], ['selected.jpg'])
            updated = [json.loads(line) for line in (folder / 'remote-results.jsonl').read_text().splitlines()]
            self.assertEqual(len(updated), 5)
            self.assertEqual(updated[1]['status'], 'skipped')
            self.assertEqual(updated[-1]['status'], 'error')


if __name__ == '__main__':
    unittest.main()
