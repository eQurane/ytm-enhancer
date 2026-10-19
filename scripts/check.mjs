import assert from 'node:assert/strict';
import { readdir, readFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

assert.equal(manifest.manifest_version, 3, 'Expected Manifest V3');
assert.equal(manifest.version, pkg.version, 'Package and manifest versions must match');
assert.deepEqual(manifest.permissions, ['storage'], 'Only storage permission is required');
assert.ok(Number(manifest.minimum_chrome_version) >= 111, 'MAIN content scripts require Chrome 111+');
assert.equal(manifest.host_permissions, undefined, 'Do not request additional host access');
assert.equal(manifest.content_scripts?.length, 2, 'Expected isolated storage bridge and page adapter');

for (const script of manifest.content_scripts) {
  assert.deepEqual(script.matches, ['https://music.youtube.com/*'], 'Limit injection to YouTube Music');
  assert.equal(script.all_frames ?? false, false, 'Only inject in the top frame');
  assert.equal(script.run_at, 'document_idle');
  assert.ok(['MAIN', 'ISOLATED'].includes(script.world));
  assert.ok(script.js?.length > 0, 'A content script needs JavaScript');
  for (const asset of [...script.js, ...(script.css ?? [])]) {
    assert.ok(!asset.includes('..') && !asset.includes(':'), 'Content assets must be local');
    await access(resolve(root, asset));
  }
}
assert.equal(manifest.content_scripts[0].world, 'ISOLATED');
assert.equal(manifest.content_scripts[1].world, 'MAIN');
const isolatedScripts = new Set(manifest.content_scripts[0].js);
assert.ok(manifest.content_scripts[1].js.every((asset) => !isolatedScripts.has(asset)),
  'Use distinct script paths in isolated and MAIN worlds; Chromium can deduplicate injections');

for (const entry of [
  manifest.background.service_worker,
  manifest.options_ui.page,
  manifest.action.default_popup,
]) {
  await access(resolve(root, entry));
}

async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await checkDirectory(path);
    } else if (/\.(?:js|mjs)$/.test(entry.name)) {
      execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      const source = await readFile(path, 'utf8');
      for (const [, dependency] of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        if (dependency.startsWith('.')) await access(resolve(dirname(path), dependency));
      }
    } else if (entry.name.endsWith('.html')) {
      const html = await readFile(path, 'utf8');
      for (const [, asset] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        await access(resolve(dirname(path), asset));
      }
    }
  }
}

await checkDirectory(join(root, 'src'));
await checkDirectory(join(root, 'tests'));
console.log('OK: manifest, versions, JavaScript syntax and local file references.');
