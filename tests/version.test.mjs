import assert from 'node:assert/strict';
import test from 'node:test';
import { formatReleaseVersion, parseReleaseVersion } from '../scripts/version.mjs';

test('release time uses Seoul across UTC date and year boundaries', () => {
  assert.equal(formatReleaseVersion(new Date('2026-10-19T05:15:00Z')), '26.10.19.1415');
  assert.equal(formatReleaseVersion(new Date('2026-12-31T15:05:00Z')), '27.01.01.0005');
  assert.throws(() => formatReleaseVersion(new Date('2099-12-31T15:00:00Z')));
});

test('display versions preserve padding while Chromium components have no leading zeros', () => {
  assert.deepEqual(parseReleaseVersion('27.01.02.0005'), {
    versionName: '27.01.02.0005', version: '27.1.2.5',
  });
  assert.equal(parseReleaseVersion('26.10.19.1415').version, '26.10.19.1415');
  assert.equal(parseReleaseVersion('28.02.29.0000').version, '28.2.29.0');
});

test('versions reject nonexistent dates, invalid times and unsafe tag names', () => {
  for (const value of ['26.02.29.1415', '26.04.31.1415', '26.00.19.1415', '26.13.19.1415',
    '26.10.00.1415', '26.10.19.2400', '26.10.19.1460', '26.10.19-1415',
    '26.1.19.1415', 'v26.10.19.1415', '../26.10.19.1415', '26.10.19.1415\n']) {
    assert.throws(() => parseReleaseVersion(value), value);
  }
});

test('Chromium versions increase across minute, day, month and year rollovers', () => {
  const labels = ['26.10.19.0005', '26.10.19.0100', '26.10.19.2359',
    '26.10.20.0000', '26.11.01.0000', '27.01.01.0000'];
  const versions = labels.map((label) => parseReleaseVersion(label).version.split('.').map(Number));
  for (let index = 1; index < versions.length; index += 1) {
    const component = versions[index].findIndex((value, part) => value !== versions[index - 1][part]);
    assert.ok(component >= 0 && versions[index][component] > versions[index - 1][component]);
  }
});
