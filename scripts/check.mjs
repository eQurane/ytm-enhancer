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

for (const entry of [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
]) {
  await access(resolve(root, entry));
}

async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await checkDirectory(path);
    } else if (entry.name.endsWith('.js')) {
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
console.log('OK: manifest, versions, JavaScript syntax and local file references.');
