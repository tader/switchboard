#!/usr/bin/env python3
"""Disposable real-Docker rehearsal of both distributed Compose variants."""
import argparse, json, os, pathlib, shutil, socket, subprocess, tempfile, time, urllib.request
parser = argparse.ArgumentParser()
parser.add_argument("--variant", choices=["image", "source"], help="Run one isolated variant; default runs both")
variant = parser.parse_args().variant
root = pathlib.Path(__file__).resolve().parent.parent
scratch = pathlib.Path(os.environ.get('SWITCHBOARD_REHEARSAL_DIR', str(pathlib.Path.home()/'.cache')))
scratch.mkdir(parents=True, exist_ok=True)
base = pathlib.Path(tempfile.mkdtemp(prefix='compose-manager-rehearsal-', dir=scratch)).resolve()
env = dict(os.environ, SWITCHBOARD_WRAPPER_IMAGE='switchboard-updater:desktop-test')
def run(args, cwd=None, **kwargs):
    return subprocess.check_output(args, cwd=cwd, env=env, stderr=subprocess.STDOUT, text=True, **kwargs).strip()
def request(url, payload=None, token=None):
    body=None if payload is None else json.dumps(payload).encode()
    headers={'content-type':'application/json','origin':url.split('/api')[0]}
    if token: headers['authorization']='Bearer '+token
    with urllib.request.urlopen(urllib.request.Request(url,body,headers),timeout=10) as r: return json.load(r)
def wait(url):
    end=time.monotonic()+100
    while time.monotonic()<end:
        try: request(url+'/readyz'); return
        except Exception: time.sleep(.3)
    raise RuntimeError('Readiness timeout')
for source in ([variant == "source"] if variant else [False,True]):
    name='source' if source else 'image'; bundle=base/name; shutil.copytree(root/'distribution/compose',bundle)
    env['SWITCHBOARD_BUNDLE_DIR']=str(bundle)
    with socket.socket() as sock: sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
    project='swb-rehearsal-'+str(os.getpid())+'-'+name
    revision=run(['git','rev-parse','HEAD'],root)
    (bundle/'.env').write_text(f'COMPOSE_PROJECT_NAME={project}\nSWITCHBOARD_PORT={port}\nSWITCHBOARD_PUBLIC_URL=http://127.0.0.1:{port}\nSWITCHBOARD_IMAGE=switchboard:desktop-test\nSWITCHBOARD_UPDATER_IMAGE=switchboard-updater:desktop-test\nSWITCHBOARD_SOURCE_BUILD={str(source).lower()}\nSWITCHBOARD_SOURCE_DIR={root}\nSWITCHBOARD_REVISION={revision}\n')
    def wrapper(*args): return run(['./switchboard',*args],bundle)
    url=f'http://127.0.0.1:{port}'
    unrelated=project+'-unrelated'
    run(['docker','run','-d','--name',unrelated,'--entrypoint','node','switchboard:desktop-test','-e','setInterval(()=>{},1000)'])
    try:
        wrapper('up'); wait(url)
        # Only synthetic first-run information from this disposable stack is read.
        logs=run(['docker','compose','--project-directory',str(bundle),'-p',project,'-f',str(bundle/'compose.yaml'),'logs','--no-color','switchboard'],bundle)
        setup=next(line.split('/invite#')[1].strip() for line in logs.splitlines() if '/invite#' in line)
        request(url+'/api/auth/invite',{'token':setup,'password':'synthetic-test-password'})
        login=request(url+'/api/auth/login',{'username':'admin','password':'synthetic-test-password'})
        # Login session is intentionally not extracted into persistent artifacts.
        jar=__import__('http.cookiejar',fromlist=['CookieJar']).CookieJar()
        opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        opener.open(urllib.request.Request(url+'/api/auth/login',json.dumps({'username':'admin','password':'synthetic-test-password'}).encode(),{'content-type':'application/json','origin':url})).read()
        response=opener.open(urllib.request.Request(url+'/api/admin/updates/enrollment',b'{}',{'content-type':'application/json','origin':url})); code=json.load(response)['code']
        wrapper('enroll',code)
        time.sleep(3)
        status=json.load(opener.open(url+'/api/admin/updates')); assert status['paired']
        before=run(['docker','volume','inspect',project+'-app-data','--format','{{.Name}}'])
        backup_output=wrapper('backup')
        import re
        backup_id=re.search(r'Backup saved: (manual-[0-9]+)',backup_output).group(1)
        shutil.copy2(root/'scripts/rehearse-controller.mjs',bundle/'rehearse-controller.mjs')
        compose=['docker','compose','--project-directory',str(bundle),'-p',project,'-f',str(bundle/'compose.yaml')]
        run(compose+['stop','updater'],bundle)
        candidate=run(['docker','image','inspect','switchboard:desktop-candidate','--format','{{.Id}}'])
        print(run(compose+['run','--rm','--no-deps','-e','CANDIDATE_IMAGE='+candidate,'-e','CANDIDATE_REVISION='+'b'*40,'updater','node',str(bundle/'rehearse-controller.mjs')],bundle),flush=True)
        run(compose+['up','-d','updater'],bundle)
        wrapper('restart'); wait(url)
        wrapper('down'); wrapper('up'); wait(url)
        status=json.load(opener.open(url+'/api/admin/updates')); assert status['build']['revision']=='b'*40
        wrapper('restore',backup_id); wait(url)
        restored=json.load(opener.open(url+'/api/admin/updates')); assert restored['build']['revision']==revision
        assert before==run(['docker','volume','inspect',project+'-app-data','--format','{{.Name}}'])
        assert run(['docker','inspect',unrelated,'--format','{{.State.Running}}'])=='true'
        print(f'PASS {name}: start, first user, enroll, pairing, named-volume backup, restart, down/up, persisted login/data, unrelated service intact',flush=True)
    except subprocess.CalledProcessError as e:
        # Do not print commands that contain one-time enrollment codes.
        print(e.output[-5000:]); raise RuntimeError('Compose operation failed') from None
    finally:
        try: wrapper('down','-v')
        finally: run(['docker','rm','-f',unrelated])
print('Artifacts: '+str(base))
