import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore JavaScript workflow helper runs under Node directly.
import { imageTags } from '../.github/scripts/image-tags.mjs';
const sha = 'a'.repeat(40);
test('image tags bind releases to their version and preserve latest for older and prereleases', () => {
  const image = 'ghcr.io/tader/switchboard';
  assert.deepEqual(imageTags('tader/switchboard', sha, '0.1.3', sha, false), [`${image}:edge`, `${image}:sha-${sha}`]);
  assert.deepEqual(imageTags('tader/switchboard', sha, '1.2.0', 'v1.2.0', true, 'v1.2.0'), [`${image}:1.2.0`, `${image}:sha-${sha}`, `${image}:latest`]);
  assert.ok(!imageTags('tader/switchboard', sha, '1.2.0', 'v1.2.0', true, 'v2.0.0').some((t: string) => t.endsWith(':latest')));
  assert.ok(!imageTags('tader/switchboard', sha, '2.0.0-beta.1', 'v2.0.0-beta.1', true, 'v2.0.0-beta.1').some((t: string) => t.endsWith(':latest')));
  assert.throws(() => imageTags('tader/switchboard', sha, '1.2.0', 'v1.1.0', true, 'v1.1.0'), /must match/);
});
