"""Verify ignored model assets or restore them from the original local projects."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
SOURCE_MAP = {'services/image-processing/': 'walee_image_processing'}

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['check', 'restore'])
    p.add_argument('--source-root', type=Path, default=Path.home())
    args = p.parse_args()
    failures = []
    for asset in json.loads((ROOT / 'artifacts.json').read_text()):
        dest = ROOT / asset['path']
        if args.action == 'restore' and not dest.exists():
            prefix = next(k for k in SOURCE_MAP if asset['path'].startswith(k))
            src = args.source_root / SOURCE_MAP[prefix] / asset['path'][len(prefix):]
            if src.is_file():
                if hashlib.sha256(src.read_bytes()).hexdigest() != asset['sha256']:
                    failures.append(asset['path'] + ': source checksum mismatch')
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
        if not dest.is_file():
            failures.append(asset['path'] + ': missing')
        elif hashlib.sha256(dest.read_bytes()).hexdigest() != asset['sha256']:
            failures.append(asset['path'] + ': checksum mismatch')
    if failures:
        raise SystemExit('\n'.join(failures))
    print('All model assets match artifacts.json')

if __name__ == '__main__':
    main()
