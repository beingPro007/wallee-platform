"""Snapshot, submit and retrieve a read-only full-catalog Modal rotation pass.

Use MODAL_PROFILE=harrir-prod-2. Credentials are read only from the admin env,
then checked against the explicitly authorized Gautam identity. Never uses the
machine's default AWS credential chain. Reports stay outside the Git checkout.
"""
import argparse
import csv
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit, unquote

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_ARN = 'arn:aws:iam::071788126830:user/Gautam'


def aws_client():
    import boto3
    env = {}
    for line in (ROOT / 'apps/admin/.env').read_text().splitlines():
        key, separator, value = line.partition('=')
        if separator and not key.lstrip().startswith('#'):
            env[key.strip()] = value.strip().strip('\"\'')
    session = boto3.Session(aws_access_key_id=env['AWS_ACCESS_KEY_ID'],
                            aws_secret_access_key=env['AWS_SECRET_ACCESS_KEY'],
                            region_name=env.get('AWS_DEFAULT_REGION', 'us-east-1'))
    assert session.client('sts').get_caller_identity()['Arn'] == EXPECTED_ARN
    assert env['AWS_BUCKET_NAME'] == 'insta-to-s3'
    return session.client('s3'), env['AWS_BUCKET_NAME']


def catalog_paths(data):
    if isinstance(data, dict):
        entries = data.get('wallpapers', [])
    elif isinstance(data, list):
        entries = data
    else:
        raise ValueError('Unsupported catalog format')
    paths = set()
    for entry in entries:
        value = entry if isinstance(entry, str) else entry.get('p', entry.get('path', ''))
        if not value:
            raise ValueError('Unrecognized catalog entry')
        path = unquote(urlsplit(value).path).lstrip('/') if '://' in value else value.lstrip('/')
        if path.startswith('thumbs/') or not path.lower().endswith(('.jpg', '.jpeg', '.png', '.webp', '.avif')):
            raise ValueError(f'Unexpected image path: {path}')
        paths.add(path)
    return paths


def snapshot(directory, threshold):
    from concurrent.futures import ThreadPoolExecutor
    s3, bucket = aws_client()
    inventory = {}
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket):
        for obj in page.get('Contents', []):
            inventory[obj['Key']] = {'etag': obj['ETag'], 'bytes': obj['Size']}
    catalogs = sorted(k for k in inventory if k.endswith('.json'))
    def read(key):
        obj = s3.get_object(Bucket=bucket, Key=key, IfMatch=inventory[key]['etag'])
        data = json.loads(obj['Body'].read())
        return key, catalog_paths(data)
    paths = set()
    metadata = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for key, members in pool.map(read, catalogs):
            paths.update(members)
            metadata.append({'key': key, 'etag': inventory[key]['etag'], 'unique_images': len(members)})
    assert paths, 'No catalog images found'
    sources = [{'key': key, **inventory.get(key, {'etag': None, 'bytes': 0})} for key in sorted(paths)]
    manifest = {'run_id': directory.name, 'created_at': datetime.now(timezone.utc).isoformat(),
                'bucket': bucket, 'threshold': threshold, 'total': len(paths), 'catalogs': metadata,
                'gpu': 'T4', 'cpu': 24, 'io_workers': 24, 'gpu_batch_size': 24,
                'mode': 'classification_only', 'preprocessing': 'EXIF-transpose + existing RotNet Resize288 CenterCrop288'}
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    (directory / 'sources.json').write_text(json.dumps(sources, indent=2))
    print(json.dumps({'run_id': directory.name, 'total': len(paths), 'catalogs': len(catalogs),
                      'missing_at_snapshot': sum(not s['etag'] for s in sources), 'directory': str(directory)}))


def submit(directory):
    import modal
    s3, bucket = aws_client()
    manifest = json.loads((directory / 'manifest.json').read_text())
    sources = json.loads((directory / 'sources.json').read_text())
    for source in sources:
        source['url'] = s3.generate_presigned_url('get_object', Params={
            'Bucket': bucket, 'Key': source['key'], 'IfMatch': source['etag']}, ExpiresIn=86400) if source['etag'] else ''
    service = modal.Cls.from_name('wall-e-catalog-orientation', 'CatalogOrientation')()
    call = service.run.spawn(manifest, sources)
    (directory / 'call-id.txt').write_text(call.object_id)
    print(json.dumps({'run_id': manifest['run_id'], 'call_id': call.object_id, 'submitted': True}))


def status(directory, fetch=False):
    import modal
    call = modal.FunctionCall.from_id((directory / 'call-id.txt').read_text().strip())
    volume = modal.Volume.from_name('wall-e-catalog-orientation-reports')
    try:
        result = call.get(timeout=0)
        print(json.dumps(result))
    except TimeoutError:
        try:
            progress = b''.join(volume.read_file(f'{directory.name}/progress.json'))
            checkpoint = json.loads(progress)
            checkpoint['call_state'] = 'running'
            if checkpoint.get('state') != 'running':
                checkpoint['note'] = 'Retry is running; showing the previous completed checkpoint.'
            print(json.dumps(checkpoint, indent=2))
        except FileNotFoundError:
            print('Job is running; waiting for its first checkpoint')
        return
    names = ['summary.json', 'manifest.json', 'results.jsonl'] if fetch else ['summary.json']
    for name in names:
        data = b''.join(volume.read_file(f'{directory.name}/{name}'))
        (directory / ('remote-' + name)).write_bytes(data)
    if fetch:
        rows = [json.loads(line) for line in (directory / 'remote-results.jsonl').read_text().splitlines()]
        sources = {source['key']: source for source in json.loads((directory / 'sources.json').read_text())}
        assert len(rows) == len(sources) and {row['key'] for row in rows} == set(sources), 'Incomplete report'
        threshold = json.loads((directory / 'manifest.json').read_text())['threshold']
        for row in rows:
            assert row['source_etag'] == sources[row['key']]['etag'], 'Source snapshot mismatch'
            if row['status'] != 'error':
                assert abs(sum(row['probabilities'].values()) - 1) < 0.00001
                assert row['rotation_candidate'] == (row['pred_rotation'] != 0 and row['confidence'] >= threshold)
        fields = ['key', 'status', 'pred_rotation', 'confidence', 'suggested_fix_rotation', 'exif_orientation', 'error']
        for filename, selected in [('classifications.csv', rows),
                                   ('rotation-candidates.csv', [r for r in rows if r['status'] == 'rotation_candidate']),
                                   ('uncertain.csv', [r for r in rows if r['status'] == 'uncertain'])]:
            with (directory / filename).open('w', newline='') as stream:
                writer = csv.DictWriter(stream, fieldnames=fields, extrasaction='ignore')
                writer.writeheader()
                writer.writerows(selected)
        print('Verified complete coverage and threshold decisions; exported review CSV files.')


if __name__ == '__main__':
    # The sibling deployment wrapper is named modal.py; import the SDK instead.
    sys.path = [path for path in sys.path if Path(path).resolve() != Path(__file__).resolve().parent]
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['snapshot', 'submit', 'status', 'fetch'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('--threshold', type=float, default=0.95)
    args = parser.parse_args()
    assert 0.85 <= args.threshold <= 1
    if args.action == 'snapshot':
        snapshot(args.directory, args.threshold)
    elif args.action == 'submit':
        submit(args.directory)
    else:
        status(args.directory, fetch=args.action == 'fetch')
