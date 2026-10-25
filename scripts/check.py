"""Offline checks: staged/tracked files, secret patterns, Python syntax and JSON."""
import ast
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    'AWS access key': rb'(?:AKIA|ASIA)[A-Z0-9]{16}',
    'GitHub token': rb'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})',
    'Hugging Face token': rb'hf_[A-Za-z0-9]{25,}',
    'JWT credential': rb'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}',
    'private key': rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'Supabase secret': rb'sb_secret_[A-Za-z0-9_-]{20,}',
}

def main():
    names = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    failures = []
    count = 0
    # Also catch exact server-side values from local .env files without logging them.
    known_secrets = set()
    for folder in ['apps/admin', 'services/image-processing', 'services/search-encoder']:
        for env in (ROOT / folder).glob('.env*'):
            if env.name.endswith('.example'):
                continue
            for line in env.read_text().splitlines():
                key, sep, value = line.partition('=')
                value = value.strip().strip('\"\'')
                if sep and re.search(r'(?:KEY|TOKEN|SECRET|PASSWORD)', key, re.I) and len(value) >= 16:
                    known_secrets.add(value.encode())
    for name in filter(None, names):
        path = ROOT / name
        if not path.is_file():
            continue
        count += 1
        if (path.name.startswith('.env') and not path.name.endswith('.example')) or path.name == '.dev.vars':
            failures.append(f'{name}: environment file must not be tracked')
        if any(x in path.parts for x in ['node_modules', '.next', '.vercel', '.aws', '.wrangler']):
            failures.append(f'{name}: generated/private directory tracked')
        if path.suffix in {'.pth', '.pt', '.onnx', '.pkl', '.npy', '.bundle', '.pem', '.key'}:
            failures.append(f'{name}: private/binary artifact tracked')
        if path.stat().st_size > 10 * 1024 * 1024:
            failures.append(f'{name}: larger than 10 MiB')
            continue
        data = path.read_bytes()
        for label, pattern in PATTERNS.items():
            if re.search(pattern, data):
                failures.append(f'{name}: potential {label} (value redacted)')
        if any(secret in data for secret in known_secrets):
            failures.append(f'{name}: contains a local environment credential (redacted)')
        try:
            if path.suffix == '.py':
                ast.parse(data, filename=name)
            elif path.suffix in {'.json', '.ipynb'}:
                json.loads(data)
        except (SyntaxError, ValueError) as exc:
            failures.append(f'{name}: {type(exc).__name__}')
    if not count:
        failures.append('No tracked files; stage files before running checks')
    if failures:
        raise SystemExit('\n'.join(failures))
    print(f'Checked {count} tracked files: syntax, JSON, secret patterns and excluded artifacts passed')

if __name__ == '__main__':
    main()
