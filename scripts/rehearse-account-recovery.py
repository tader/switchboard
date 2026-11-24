#!/usr/bin/env python3
"""Rehearse the account migration against synthetic data created by an older revision."""
import argparse, io, os, pathlib, subprocess, tarfile, tempfile
p = argparse.ArgumentParser()
p.add_argument('--baseline', required=True, help='Revision before the account recovery migration')
a = p.parse_args()
root = pathlib.Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='account-migration-') as scratch:
    work = pathlib.Path(scratch)
    baseline = work / 'baseline'; baseline.mkdir()
    archive = subprocess.check_output(['git', 'archive', a.baseline], cwd=root)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(baseline, filter='data')
    (baseline / 'node_modules').symlink_to((root / 'node_modules').resolve(), target_is_directory=True)
    data = work / 'data'; data.mkdir()
    env = dict(os.environ, SWITCHBOARD_DATA_DIR=str(data))
    seed = """
      import fs from 'node:fs';
      import { initDb, db } from './server/db.ts';
      import { initKey, encrypt } from './server/crypto.ts';
      import { createUser, setPassword, createInvite, createSession } from './server/users.ts';
      initKey(); initDb();
      const user = createUser('synthetic-owner', 'admin'); setPassword(user.id, 'synthetic-original-password');
      fs.writeFileSync(process.env.SWITCHBOARD_DATA_DIR + '/fixture.json', JSON.stringify({
        id: user.id, invite: createInvite(user.id).url, session: createSession(user.id),
        encrypted: encrypt({ value: 'synthetic-secret' }), schema: db.prepare('PRAGMA user_version').get().user_version
      })); db.close();
    """
    subprocess.run(['node', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', seed], cwd=baseline, env=env, check=True)
    verify = """
      import fs from 'node:fs'; import assert from 'node:assert/strict';
      import { initDb, db } from './server/db.ts'; import { initKey, decrypt } from './server/crypto.ts';
      import { checkLogin, inviteUser, inviteAllowsUsername, sessionUser, acceptInvite } from './server/users.ts';
      const fixture = JSON.parse(fs.readFileSync(process.env.SWITCHBOARD_DATA_DIR + '/fixture.json'));
      initKey(); initDb();
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, fixture.schema + 1);
      assert.equal(checkLogin('synthetic-owner', 'synthetic-original-password').id, fixture.id);
      assert.equal(sessionUser(fixture.session).id, fixture.id);
      assert.deepEqual(decrypt(fixture.encrypted), { value: 'synthetic-secret' });
      const token = new URL(fixture.invite).hash.slice(1);
      assert.equal(inviteUser(token).id, fixture.id); assert.equal(inviteAllowsUsername(token), false);
      assert.throws(() => acceptInvite(token, 'synthetic-new-password', 'renamed'));
      assert.equal(acceptInvite(token, 'synthetic-new-password').username, 'synthetic-owner');
      db.close();
    """
    subprocess.run(['node', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', verify], cwd=root, env=env, check=True)
print('PASS: previous-schema account, password, session, invite and encrypted data survive migration; legacy invites cannot rename users')
