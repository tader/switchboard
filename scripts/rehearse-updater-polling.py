#!/usr/bin/env python3
"""Exercise the actual Compose updater daemon against disposable synthetic data.

Build switchboard:polling-test and switchboard-updater:polling-test first using
Dockerfile and updater/Dockerfile. No registry publication or live instance is used.
"""
import http.cookiejar
import json
import os
import pathlib
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

root = pathlib.Path(__file__).resolve().parent.parent
scratch = pathlib.Path(os.environ.get('SWITCHBOARD_REHEARSAL_DIR', str(pathlib.Path.home() / '.cache')))
scratch.mkdir(parents=True, exist_ok=True)
bundle = pathlib.Path(tempfile.mkdtemp(prefix='switchboard-polling-', dir=scratch)).resolve()
project = 'swb-polling-' + str(os.getpid())
env = dict(os.environ, SWITCHBOARD_BUNDLE_DIR=str(bundle))
shutil.copy2(root / 'distribution/compose/compose.yaml', bundle / 'compose.yaml')
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
url = f'http://127.0.0.1:{port}'
(bundle / '.env').write_text(f'COMPOSE_PROJECT_NAME={project}\nSWITCHBOARD_PORT={port}\nSWITCHBOARD_PUBLIC_URL={url}\nSWITCHBOARD_IMAGE=switchboard:polling-test\nSWITCHBOARD_UPDATER_IMAGE=switchboard-updater:polling-test\n')
compose = ['docker', 'compose', '--project-directory', str(bundle), '-p', project, '-f', str(bundle / 'compose.yaml')]

def run(args):
    try:
        return subprocess.check_output(args, cwd=bundle, env=env, stderr=subprocess.STDOUT, text=True).strip()
    except subprocess.CalledProcessError:
        # Enrollment commands and subprocess output must not reach CI artifacts.
        raise RuntimeError('Disposable Compose operation failed; output withheld') from None

def cli(*args):
    return run(compose + list(args))

opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def request(route, body=None):
    data = None if body is None else json.dumps(body).encode()
    return json.load(opener.open(urllib.request.Request(url + route, data, {'content-type': 'application/json', 'origin': url}), timeout=10))

def wait(check, message):
    end = time.monotonic() + 100
    while time.monotonic() < end:
        try:
            result = check()
            if result:
                return result
        except (OSError, ValueError):
            pass
        time.sleep(.25)
    raise RuntimeError(message)

def status():
    return request('/api/admin/updates')

def seed_job(name):
    # Owner-only injection avoids upstream release lookup; the daemon and API are real.
    build = status()['build']
    job = {'id': name, 'state': 'queued', 'createdAt': int(time.time()*1000), 'target': {'version': build['version'], 'baseRevision': build['revision'], 'revision': 'b'*40, 'protocol': 1, 'channel': 'stable', 'notes': 'Synthetic fixture', 'url': 'https://example.com/release'}}
    script = "const fs=require('fs'),p='/data/update-control.json',s=JSON.parse(fs.readFileSync(p));s.job=JSON.parse(process.argv[1]);fs.writeFileSync(p,JSON.stringify(s),{mode:384});"
    cli('exec', '-T', 'switchboard', 'node', '-e', script, json.dumps(job))
    assert status().get('job', {}).get('id') == name, 'Fixture job was not stored'

def settings(script):
    cli('exec', '-T', 'updater', 'node', '-e', "const fs=require('fs'),p='/state/settings.json',s=JSON.parse(fs.readFileSync(p));" + script + ";fs.writeFileSync(p,JSON.stringify(s),{mode:384})")

try:
    cli('up', '-d', '--pull', 'never')
    wait(lambda: request('/readyz'), 'Application readiness timeout')
    logs = cli('logs', '--no-color', 'switchboard')
    code = next(line.split('/invite#')[1].strip() for line in logs.splitlines() if '/invite#' in line)
    request('/api/auth/invite', {'token': code, 'password': 'synthetic-polling-password'})
    request('/api/auth/login', {'username': 'admin', 'password': 'synthetic-polling-password'})
    code = request('/api/admin/updates/enrollment', {})['code']
    # Enrollment output is never printed or persisted in an artifact.
    cli('exec', '-T', 'updater', 'node', 'updater/main.ts', 'enroll', '/state/settings.json', code)
    wait(lambda: status()['paired'], 'Updater pairing timeout')
    original = cli('ps', '-q', 'switchboard')

    settings("s.compose.files=[s.compose.directory+'/missing-compose.yaml']")
    cli('stop', '-t', '2', 'updater')
    seed_job('synthetic-missing-mount')
    cli('start', 'updater')
    wait(lambda: status().get('job', {}).get('state') == 'failed', 'Missing mount stayed queued')
    assert 'validate the installation' in status()['job']['error']
    assert cli('ps', '-q', 'switchboard') == original
    print('PASS actual daemon: missing Compose file reports failed; application unchanged', flush=True)

    settings("s.compose.files=[s.compose.directory+'/compose.yaml'];s.compose.dataVolume='synthetic-incorrect-volume'")
    cli('stop', '-t', '2', 'updater')
    seed_job('synthetic-wrong-volume')
    cli('start', 'updater')
    wait(lambda: status().get('job', {}).get('state') == 'failed', 'Wrong volume stayed queued')
    reason = cli('exec', '-T', 'updater', 'node', '-e', "console.log(JSON.parse(require('fs').readFileSync('/state/last-preflight-error.json')).reason)")
    assert 'exact configured host path or named volume' in reason, 'Unexpected synthetic preflight failure'
    assert cli('ps', '-q', 'switchboard') == original
    print('PASS actual daemon: mismatched data volume reports failed; application unchanged', flush=True)

    settings("s.compose.dataVolume=s.compose.project+'-app-data'")
    cli('stop', '-t', '2', 'updater')
    seed_job('synthetic-valid-preflight')
    cli('start', 'updater')
    # The target deliberately has no published image: preflight must succeed,
    # followed by a journalled preparation failure before any cutover.
    wait(lambda: status().get('job', {}).get('state') == 'failed', 'Valid preflight did not consume job')
    diagnostic = cli('exec', '-T', 'updater', 'node', '-e', "const fs=require('fs');if(!fs.existsSync('/state/journal.json'))console.log(JSON.parse(fs.readFileSync('/state/last-preflight-error.json')).reason)")
    assert not diagnostic, 'Synthetic fixture preflight unexpectedly failed'
    journal = json.loads(cli('exec', '-T', 'updater', 'node', '-e', "const j=JSON.parse(require('fs').readFileSync('/state/journal.json'));console.log(JSON.stringify({id:j.job.id,phase:j.phase,failure:j.failure.phase,backup:!!j.backup}))"))
    assert journal == {'id': 'synthetic-valid-preflight', 'phase': 'failed', 'failure': 'preparing', 'backup': False}
    assert cli('ps', '-q', 'switchboard') == original
    print('PASS actual daemon: valid installation consumes job and journals preparation; no cutover', flush=True)

    cli('stop', '-t', '2', 'updater')
    seed_job('synthetic-offline-cancel')
    request('/api/admin/updates/jobs/cancel', {})
    assert status()['job']['state'] == 'cancelled'
    assert cli('ps', '-q', 'switchboard') == original
    request('/readyz')
    print('PASS actual server: queued cancellation works with updater stopped; application healthy', flush=True)
finally:
    try:
        cli('down', '-t', '2', '-v', '--remove-orphans')
    finally:
        shutil.rmtree(bundle)
