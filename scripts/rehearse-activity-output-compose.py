import os, pathlib, subprocess, shutil, tempfile
root=pathlib.Path.cwd()
bundle=pathlib.Path(tempfile.mkdtemp(prefix='activity-compose-',dir=root.parent))
project='activity-preview-qa-'+str(os.getpid())
def run(args):
    p=subprocess.run(args,cwd=bundle,capture_output=True,text=True)
    if p.returncode:
        print(p.stdout,p.stderr)
        p.check_returncode()
    return p.stdout.strip()
shutil.copy(root/'distribution/compose/compose.yaml',bundle/'compose.yaml')
(bundle/'.env').write_text(f'COMPOSE_PROJECT_NAME={project}\nSWITCHBOARD_IMAGE=switchboard:activity-output-qa\nSWITCHBOARD_UPDATER_IMAGE=switchboard-updater:activity-output-qa\nSWITCHBOARD_BUNDLE_DIR={bundle}\nSWITCHBOARD_PORT=18879\n')
script=r"""
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {Controller,command} from '/app/updater/engine.ts';
const directory=process.env.SWITCHBOARD_BUNDLE_DIR;
const project=process.env.SWITCHBOARD_COMPOSE_PROJECT;
fs.mkdirSync('/state/backups/manual',{recursive:true});
const c=new Controller({instance:project,mode:'compose',dataDir:'/data',stateDir:'/state',appUrl:'http://switchboard:8770',env:{},compose:{directory,project,service:'switchboard',files:[directory+'/compose.yaml'],privateNetwork:true,dataVolume:project+'-app-data',stateVolume:project+'-updater-state',previewVolume:project+'-activity-previews'}});
const service=await c.composeInfo();
assert.equal(service.volumes.filter(v=>!v.read_only).length,2);
const image=JSON.parse(await command('docker',['image','inspect','switchboard:activity-output-qa']))[0].Id;
const seed=String.raw§const fs=await import('node:fs');const {initDb,run,one}=await import('./server/db.ts');const crypto=await import('./server/crypto.ts');initDb();crypto.initKey();const {db}=await import('./server/db.ts');const {createUser}=await import('./server/users.ts');const {record}=await import('./server/audit.ts');const output=await import('./server/activity-output.ts');output.initOutputStore();const u=createUser('synthetic-compose','admin');const id=record({userId:u.id,caller:{source:'proxy',tokenId:null,tokenName:null,ip:null,userAgent:null},method:'GET',url:'https://api.example.test/profile',status:200});await output.observeOutput(Response.json({account_id:'synthetic-compose-account'}),id,u.id,{fields:{account_id:{maxBytes:128}}},[]).text();const file=fs.readdirSync('/activity-previews').find(n=>n.endsWith('.enc'));if(!file)throw Error('capture missing');fs.writeFileSync('/activity-previews/expected.json',JSON.stringify({owner:u.id,id,file,ciphertext:fs.readFileSync('/activity-previews/'+file,'utf8')}));db.close();§;
await c.compose(['run','--rm','--no-deps','-e','SWITCHBOARD_ACTIVITY_PREVIEW_ROOT=/activity-previews','-e','SWITCHBOARD_ACTIVITY_PREVIEW_RESTORE_SAFE=1','switchboard','node','--input-type=module','-e',seed]);
await c.dataHelper('snapshot','/state/backups/manual',image);
const scan=String.raw§const fs=require('fs');const walk=p=>fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(p+'/'+e.name):[p+'/'+e.name]);const expected=JSON.parse(fs.readFileSync('/activity-previews/expected.json'));for(const p of walk('/snapshot')){const b=fs.readFileSync(p);if(b.includes(Buffer.from(expected.ciphertext))||b.includes(Buffer.from('synthetic-compose-account'))||p.endsWith('.enc')||p.endsWith('.tmp'))throw Error('preview leaked into snapshot');}if(!fs.existsSync('/activity-previews/'+expected.file))throw Error('backup invalidated live preview');§;
await command('docker',['run','--rm','--network=none','--entrypoint','node','--mount','type=volume,src='+project+'-updater-state,dst=/snapshot,readonly','--mount','type=volume,src='+project+'-activity-previews,dst=/activity-previews,readonly',image,'-e',scan]);
await c.invalidateOutputs(image);
await c.dataHelper('restore','/state/backups/manual',image);
const verify=String.raw§const fs=await import('node:fs');const {initDb,one}=await import('./server/db.ts');initDb();const crypto=await import('./server/crypto.ts');crypto.initKey();const output=await import('./server/activity-output.ts');output.initOutputStore();const row=one('SELECT id,user_id FROM audit_log LIMIT 1');if(output.readOutput(row.user_id,row.id,true).state==='retained')throw Error('restored preview revived');if(fs.readdirSync('/activity-previews').some(n=>n.endsWith('.enc')))throw Error('ciphertext survived restore');const {db}=await import('./server/db.ts');db.close();§;
await c.compose(['run','--rm','--no-deps','-e','SWITCHBOARD_ACTIVITY_PREVIEW_ROOT=/activity-previews','-e','SWITCHBOARD_ACTIVITY_PREVIEW_RESTORE_SAFE=1','switchboard','node','--input-type=module','-e',verify]);
console.log('PASS actual Compose: exact dedicated mount, private capture, metadata-only snapshot including database sidecars, backup preserves live file, durable invalidation and restored metadata cannot revive output');
""".replace('§',chr(96))
(bundle/'rehearse.mjs').write_text(script)
compose=['docker','compose','--project-directory',str(bundle),'-p',project,'-f',str(bundle/'compose.yaml')]
try:
    print(run(compose+['run','--rm','--no-deps','updater','node',str(bundle/'rehearse.mjs')]))
finally:
    subprocess.run(compose+['down','-v','--remove-orphans'],cwd=bundle,capture_output=True)
    shutil.rmtree(bundle)
