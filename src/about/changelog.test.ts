import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releases } from './changelog-data';
import { baseVersion } from './changelog-view';
import { readFileSync } from 'node:fs';

const kinds = new Set(['feature', 'improvement', 'fix', 'security', 'change']);
const parts = (v: string) => v.split('.').map(Number);
const newer = (a: string, b: string) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

test('every release has a valid version, kind and title, newest first, without repeats', () => {
  const seen = new Set<string>();
  releases.forEach((release, index) => {
    assert.match(release.version, /^\d+\.\d+\.\d+$/);
    assert.ok(!seen.has(release.version), `repeated ${release.version}`); seen.add(release.version);
    assert.ok(release.date === '' || /^\d{4}-\d{2}-\d{2}$/.test(release.date));
    assert.ok(release.changes.length > 0, `${release.version} has no changes`);
    for (const change of release.changes) { assert.ok(kinds.has(change.kind)); assert.ok(change.title.trim()); }
    if (index > 0) assert.ok(newer(releases[index - 1].version, release.version), `${releases[index - 1].version} before ${release.version}`);
  });
});

test('the version being built is listed', () => {
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.ok(releases.some(r => r.version === baseVersion(version)), `add ${baseVersion(version)} to changelog-data.ts`);
  assert.equal(baseVersion('1.10.0-alpha.2'), '1.10.0');
});
