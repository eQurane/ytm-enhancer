import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReleaseVersion } from './version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const release = parseReleaseVersion(pkg.version);
assert.equal(manifest.version_name, release.versionName);
assert.equal(manifest.version, release.version);
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, release.versionName, 'Tag must match the release version');
}
// Archive the committed files, never local downloads, credentials, or build output.
try {
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'manifest.json', 'package.json', 'src'],
    { cwd: root, stdio: 'pipe' });
} catch {
  throw new Error('Commit manifest.json, package.json and src changes before packaging.');
}
await mkdir(join(root, 'dist'), { recursive: true });
const archive = join(root, 'dist', `ytm-enhancer-${release.versionName}.zip`);
execFileSync('git', ['archive', '--format=zip', `--output=${archive}`, 'HEAD', 'manifest.json', 'src'],
  { cwd: root, stdio: 'inherit' });
console.log(archive);
