import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import semver from 'semver';
export function imageTags(repository, sha, version, ref, stable, latestTag) {
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid repository or commit');
  const image = `ghcr.io/${repository.toLowerCase()}`;
  if (!stable) return [`${image}:edge`, `${image}:sha-${sha}`];
  if (!semver.valid(version) || ref !== `v${version}`) throw new Error('Release tag must match package.json version');
  const tags = [`${image}:${version}`, `${image}:sha-${sha}`];
  if (!semver.prerelease(version) && latestTag === ref) tags.push(`${image}:latest`);
  return tags;
}
if (process.argv[1] === import.meta.filename) {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  const stable = process.env.STABLE === 'true';
  let latest;
  if (stable) {
    const release = JSON.parse(execFileSync('gh', ['api', `repos/${process.env.REPOSITORY}/releases/tags/${process.env.REF}`], { encoding: 'utf8' }));
    if (release.draft) throw new Error('Cannot publish a draft release');
    try { latest = execFileSync('gh', ['api', `repos/${process.env.REPOSITORY}/releases/latest`, '--jq', '.tag_name'], { encoding: 'utf8' }).trim(); } catch { /* Only prereleases may exist. */ }
  }
  const tags = imageTags(process.env.REPOSITORY, sha, version, process.env.REF, stable, latest);
  console.log(`sha=${sha}\nversion=${version}\ntags=${tags.join(',')}`);
}
