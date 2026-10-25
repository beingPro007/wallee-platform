"""Invoke Modal from the service directory with an explicit workspace profile."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SERVICE = ROOT / 'services/image-processing'
TARGETS = {'classifier': 'main.py', 'orientation': 'orientation.py', 'upscaler': 'upscaler.py', 'worker': 'worker_modal.py', 'sync': 'sync.py', 'categories': 'app/utils/categories.py'}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['deploy', 'run'])
    parser.add_argument('service', choices=[*TARGETS, 'all'])
    parser.add_argument('--profile', default=os.environ.get('MODAL_PROFILE', 'harrir-prod-2'))
    args, extra = parser.parse_known_args()
    if args.service == 'all' and (args.action != 'deploy' or extra):
        parser.error('all supports deploy only, without extra arguments')
    modal = shutil.which('modal')
    if not modal:
        parser.error('Install services/image-processing/requirements-cli.txt first')
    env = dict(os.environ, MODAL_PROFILE=args.profile)
    services = ['classifier', 'orientation', 'upscaler', 'worker'] if args.service == 'all' else [args.service]
    for name in services:
        needed = {'classifier': ['embeddings/category_names.npy', 'embeddings/category_embeddings.npy'], 'upscaler': ['RealESRGAN/weights/RealESRGAN_x2.pth']}.get(name, [])
        missing = [p for p in needed if not (SERVICE / p).is_file()]
        if missing:
            parser.error(f'Missing assets for {name}: {missing}. See docs/deployment.md.')
        print(f'{args.action} {name} in Modal profile {args.profile}', flush=True)
        subprocess.run([modal, args.action, TARGETS[name], *extra], cwd=SERVICE, env=env, check=True)

if __name__ == '__main__':
    main()
