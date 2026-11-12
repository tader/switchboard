#!/usr/bin/env python3
"""Build a self-contained ustar runtime; run after npm ci and web build.
Node must be an official verified Node 24 binary for the target architecture.
"""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, tarfile, tempfile
p = argparse.ArgumentParser()
p.add_argument('--node', required=True); p.add_argument('--arch', choices=['arm64', 'x64'], required=True)
p.add_argument('--revision', required=True); p.add_argument('--output', required=True)
a = p.parse_args()
if len(a.revision) != 40 or any(c not in '0123456789abcdef' for c in a.revision): raise SystemExit('Invalid revision')
root = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(a.output).resolve(); out.mkdir(parents=True, exist_ok=True)
version = json.loads((root / 'package.json').read_text())['version']
with tempfile.TemporaryDirectory(prefix='switchboard-runtime-') as tmp:
    stage = pathlib.Path(tmp) / 'runtime'; stage.mkdir()
    for name in ['server', 'plugins', 'docs', 'updater']:
        shutil.copytree(root / name, stage / name, symlinks=False)
    shutil.copytree(root / 'web/dist', stage / 'web/dist')
    for name in ['package.json', 'package-lock.json']:
        shutil.copy2(root / name, stage / name)
    subprocess.run(['npm', 'ci', '--omit=dev', '--ignore-scripts'], cwd=stage, check=True, stdout=subprocess.DEVNULL)
    # CLI entry-point links are unnecessary: end-user releases never run npm/builds.
    for link in list((stage / 'node_modules').rglob('*')):
        if link.is_symlink(): link.unlink()
    (stage / 'bin').mkdir(); shutil.copy2(a.node, stage / 'bin/node'); os.chmod(stage / 'bin/node', 0o755)
    license_dir = stage / 'licenses'; license_dir.mkdir()
    for name in ['LICENSE', 'LICENSE.md']:
        if (root / name).exists(): shutil.copy2(root / name, license_dir / 'Switchboard-LICENSE')
    node_license = pathlib.Path(a.node).resolve().parent.parent / 'LICENSE'
    if not node_license.exists(): raise SystemExit('Node distribution LICENSE is required')
    shutil.copy2(node_license, license_dir / 'Node-LICENSE')
    (stage / 'build-info.json').write_text(json.dumps({'version': version, 'revision': a.revision, 'protocol': 1, 'platform': 'darwin', 'arch': a.arch}))
    # Actual independent dependency-resolution/startup check on the matching runner.
    subprocess.run([str(stage / 'bin/node'), '--input-type=module', '-e', "await import('./updater/engine.ts');await import('hono');console.log('Independent runtime imports passed')"], cwd=stage, check=True)
    archive = out / f'switchboard-runtime-darwin-{a.arch}.tar.gz'
    with tarfile.open(archive, 'w:gz', format=tarfile.USTAR_FORMAT) as tar:
        for child in sorted(stage.iterdir()): tar.add(child, arcname=child.name, recursive=True)
    manifest = {'origin': 'tader/switchboard', 'version': version, 'revision': a.revision, 'protocol': 1, 'platform': 'darwin', 'arch': a.arch, 'archive': archive.name, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
    (out / f'runtime-darwin-{a.arch}.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(archive)
