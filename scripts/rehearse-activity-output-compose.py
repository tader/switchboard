#!/usr/bin/env python3
"""Exercise the released wrapper with fresh and retained settings and synthetic data."""
import json, os, pathlib, re, shutil, socket, subprocess, tempfile, time, urllib.request
root = pathlib.Path(__file__).resolve().parent.parent
bundle = pathlib.Path(tempfile.mkdtemp(prefix='activity-compose-', dir=root.parent))
project = 'activity-preview-qa-' + str(os.getpid())
env = dict(os.environ, SWITCHBOARD_WRAPPER_IMAGE='switchboard-updater:activity-output-qa')
owned_volumes = []
def run(args):
    p = subprocess.run(args, cwd=bundle, env=env, capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError('Rehearsal command failed: ' + p.stderr[-3000:])
    return p.stdout.strip()
def wrapper(*args): return run(['./switchboard', *args])
def request(path, token, body=None):
    headers = {'authorization': 'Bearer ' + token, 'content-type': 'application/json'}
    raw = None if body is None else json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(base + path, raw, headers), timeout=10) as response:
        return json.load(response)
def ready():
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(base + '/readyz', timeout=1) as response:
                if response.status == 200: return
        except Exception: pass
        time.sleep(.1)
    raise RuntimeError('Disposable server did not become ready')
shutil.copytree(root/'distribution/compose', bundle, dirs_exist_ok=True)
with socket.socket() as sock: sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
base = 'http://127.0.0.1:' + str(port)
(bundle/'.env').write_text(f'COMPOSE_PROJECT_NAME={project}\nSWITCHBOARD_IMAGE=switchboard:activity-output-qa\nSWITCHBOARD_UPDATER_IMAGE=switchboard-updater:activity-output-qa\nSWITCHBOARD_PORT={port}\nSWITCHBOARD_PUBLIC_URL={base}\n')
compose = ['docker', 'compose', '--project-directory', str(bundle), '-p', project, '-f', str(bundle/'compose.yaml')]
def exec_node(service, code):
    return run(compose + ['exec', '-T'] + (['--user', 'node'] if service == 'switchboard' else []) + [service, 'node', '--input-type=module', '-e', code])
def capture():
    code = """const d=await import('./server/db.ts');d.initDb();const c=await import('./server/crypto.ts');c.initKey();const a=await import('./server/audit.ts');const o=await import('./server/activity-output.ts');o.initOutputStore();const user=d.one("SELECT id FROM users WHERE username='synthetic-preview-owner'");const id=a.record({userId:user.id,caller:{source:'proxy',tokenId:null,tokenName:null,ip:null,userAgent:null},method:'GET',url:'https://api.example.test/profile',status:200});await o.observeOutput(Response.json({account_id:'synthetic-output-account'}),id,user.id,{fields:{account_id:{maxBytes:128}}},[]).text();const fs=await import('node:fs');const files=fs.readdirSync('/activity-previews').filter(n=>n.endsWith('.enc'));const file=files.at(-1);if(!file)throw Error('capture missing');console.log(JSON.stringify({id,file,ciphertext:fs.readFileSync('/activity-previews/'+file,'utf8')}));d.db.close();"""
    return json.loads(exec_node('switchboard', code))
def inspect_preview(volume, code):
    return run(['docker', 'run', '--rm', '--network=none', '--entrypoint', 'node', '--mount', 'type=volume,src='+volume+',dst=/activity-previews,readonly', 'switchboard:activity-output-qa', '-e', code])
try:
    wrapper('up'); ready()
    seed = """const d=await import('./server/db.ts');d.initDb();const c=await import('./server/crypto.ts');c.initKey();const u=await import('./server/users.ts');const owner=u.createUser('synthetic-preview-owner','admin');console.log(u.createToken(owner.id,'synthetic-admin',null).secret);d.db.close();"""
    token = exec_node('switchboard', seed)
    assert request('/api/admin/activity-retention', token)['capture']['available']
    code = request('/api/admin/updates/enrollment', token, {})['code']
    wrapper('enroll', code)
    first = capture()
    old_volume = project + '-activity-previews'; owned_volumes.append(old_volume)
    exec_node('switchboard', "const fs=await import('node:fs');fs.writeFileSync('/activity-previews/unrelated-sentinel','must survive',{mode:384})")
    backup = re.search(r'Backup saved: (manual-[0-9]+)', wrapper('backup')).group(1)
    assert inspect_preview(old_volume, "const fs=require('fs');if(!fs.readdirSync('/activity-previews').some(n=>n.endsWith('.enc')))throw Error('backup removed preview');console.log('ok')") == 'ok'
    scan = """const fs=await import('node:fs');const walk=p=>fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(p+'/'+e.name):[p+'/'+e.name]);for(const p of walk('/state/backups/""" + backup + """')){const b=fs.readFileSync(p);if(b.includes(Buffer.from(""" + json.dumps(first['ciphertext']) + """))||b.includes(Buffer.from('synthetic-output-account'))||p.endsWith('.enc')||p.endsWith('.tmp'))throw Error('preview leaked into snapshot');}console.log('ok')"""
    assert exec_node('updater', scan) == 'ok'
    exec_node('updater', "const fs=await import('node:fs');const p='/state/settings.json',s=JSON.parse(fs.readFileSync(p));delete s.compose.previewVolume;fs.writeFileSync(p,JSON.stringify(s),{mode:384})")
    wrapper('restore', backup); ready()
    assert request('/api/audit/'+str(first['id'])+'/output', token)['state'] != 'retained'
    assert request('/api/admin/activity-retention', token)['capture']['available']
    assert inspect_preview(old_volume, "const fs=require('fs');if(fs.readdirSync('/activity-previews').some(n=>n.endsWith('.enc')))throw Error('old preview survived');console.log(fs.readFileSync('/activity-previews/unrelated-sentinel','utf8'))") == 'must survive'
    second = capture()
    backup2 = re.search(r'Backup saved: (manual-[0-9]+)', wrapper('backup')).group(1)
    replacement = project + '-replacement-previews'; owned_volumes.append(replacement)
    run(['docker', 'volume', 'create', replacement])
    text = (bundle/'compose.yaml').read_text().replace(chr(36)+'{COMPOSE_PROJECT_NAME:-switchboard}-activity-previews', replacement)
    (bundle/'compose.yaml').write_text(text)
    exec_node('updater', "const fs=await import('node:fs');const p='/state/settings.json',s=JSON.parse(fs.readFileSync(p));s.compose.previewVolume="+json.dumps(replacement)+";fs.writeFileSync(p,JSON.stringify(s),{mode:384})")
    wrapper('restore', backup2); ready()
    assert request('/api/audit/'+str(second['id'])+'/output', token)['state'] != 'retained'
    assert inspect_preview(old_volume, "const fs=require('fs');if(fs.readdirSync('/activity-previews').some(n=>n.endsWith('.enc')))throw Error('detached preview revived');console.log(fs.readFileSync('/activity-previews/unrelated-sentinel','utf8'))") == 'must survive'
    exec_node('updater', "const fs=await import('node:fs');const p='/state/settings.json',s=JSON.parse(fs.readFileSync(p));delete s.compose.previewVolume;fs.writeFileSync(p,JSON.stringify(s),{mode:384})")
    (bundle/'compose.yaml').write_text((root/'distribution/compose/compose.yaml').read_text())
    wrapper('up'); ready()
    assert request('/api/admin/activity-retention', token)['capture']['available']
    capture()
    # Prove a differently named volume can still alias data: inspect backing, not just names.
    alias = project + '-ambiguous-previews'; owned_volumes.append(alias)
    data_mount = json.loads(run(['docker', 'volume', 'inspect', project+'-app-data']))[0]['Mountpoint']
    run(['docker', 'volume', 'create', '--driver', 'local', '--opt', 'type=none', '--opt', 'o=bind', '--opt', 'device='+data_mount, alias])
    exec_node('updater', "const fs=await import('node:fs');const p='/state/settings.json',s=JSON.parse(fs.readFileSync(p));s.compose.previewVolume="+json.dumps(alias)+";fs.writeFileSync(p,JSON.stringify(s),{mode:384})")
    (bundle/'compose.yaml').write_text((root/'distribution/compose/compose.yaml').read_text().replace(chr(36)+'{COMPOSE_PROJECT_NAME:-switchboard}-activity-previews', alias))
    wrapper('stop')
    def db_hash():
        return run(['docker','run','--rm','--network=none','--entrypoint','node','--mount','type=volume,src='+project+'-app-data,dst=/data,readonly','switchboard:activity-output-qa','-e',"console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('/data/switchboard.db')).digest('hex'))"])
    before = db_hash()
    try:
        wrapper('restore', backup2)
        raise AssertionError('Ambiguous backing was accepted')
    except RuntimeError as error:
        assert 'driver options' in str(error), str(error)
    assert db_hash() == before
    print('PASS released Compose wrapper: fresh up/enroll activates capture; snapshot excludes ciphertext/sidecars; backup preserves preview; missing/changed store settings restore safely using durable history; unrelated sentinel survives; retained settings migrate through normal up; actual bind-alias volume rejected before data replacement')
finally:
    subprocess.run(compose+['down','-v','--remove-orphans'],cwd=bundle,env=env,capture_output=True)
    for volume in owned_volumes: subprocess.run(['docker','volume','rm',volume],capture_output=True)
    shutil.rmtree(bundle)
