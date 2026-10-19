import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseReleaseVersion(versionName) {
  const match = /^(\d{2})\.(\d{2})\.(\d{2})\.(\d{2})(\d{2})$/.exec(versionName);
  if (!match || match[0] !== versionName) throw new Error('Expected version yy.mm.dd.hhmm');
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(2000 + year, month - 1, day, hour, minute));
  if (date.getUTCFullYear() !== 2000 + year || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day || hour > 23 || minute > 59) {
    throw new Error('Version must contain a valid date and time');
  }
  return {
    versionName,
    // Chromium forbids leading zeros in the four numeric version components.
    version: [year, month, day, hour * 100 + minute].join('.'),
  };
}

export function formatReleaseVersion(date = new Date()) {
  const fullYear = Number(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Seoul', year: 'numeric',
  }).format(date));
  if (fullYear < 2000 || fullYear > 2099) throw new Error('Two-digit years support 2000–2099');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}.${parts.month}.${parts.day}.${parts.hour}${parts.minute}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: npm run version:date -- [yy.mm.dd.hhmm]');
  const release = parseReleaseVersion(process.argv[2] ?? formatReleaseVersion());
  const manifestUrl = new URL('../manifest.json', import.meta.url);
  const packageUrl = new URL('../package.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const pkg = JSON.parse(await readFile(packageUrl, 'utf8'));
  manifest.version = release.version;
  manifest.version_name = release.versionName;
  pkg.version = release.versionName;
  await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(packageUrl, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`Version: ${release.versionName} (Chromium: ${release.version}, Asia/Seoul)`);
}
