import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { TestContext } from 'node:test';

const generator = fileURLToPath(new URL('../scripts/homebrew-formula.mjs', import.meta.url));
const manifest = {
  name: '@example/switchboard', version: '0.1.0-beta.1', private: false,
  description: 'Automatic model and effort routing',
  homepage: 'https://example.com/switchboard', license: 'Apache-2.0',
  bin: { switchboard: 'bin/switchboard.mjs' },
};

async function archive(t: TestContext, metadata: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'router distribution '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'package'));
  await writeFile(join(dir, 'package/package.json'), JSON.stringify(metadata));
  const tarball = join(dir, 'release.tgz');
  const packed = spawnSync('tar', ['-czf', tarball, '-C', dir, 'package'], { encoding: 'utf8' });
  assert.ifError(packed.error);
  assert.equal(packed.status, 0, packed.stderr);
  return tarball;
}

test('Homebrew formula uses the packed scoped identity and checksum, not checkout metadata', async t => {
  const tarball = await archive(t, manifest);
  const result = spawnSync(process.execPath, [generator, tarball], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /class Switchboard < Formula/);
  assert.match(result.stdout, /url "https:\/\/registry\.npmjs\.org\/@example\/switchboard\/-\/switchboard-0\.1\.0-beta\.1\.tgz"/);
  assert.match(result.stdout, /version "0\.1\.0-beta\.1"/);
  const digest = createHash('sha256').update(await readFile(tarball)).digest('hex');
  assert.ok(result.stdout.includes(`sha256 "${digest}"`));
  assert.match(result.stdout, /bin\/"switchboard", "init", "--yes"/);
  assert.match(result.stdout, /bin\/"switchboard", "config", "check"/);
});

test('Homebrew generation refuses unresolved release metadata without producing a formula', async t => {
  for (const change of [
    { private: true }, { name: 'switchboard-prototype' }, { homepage: undefined },
    { license: undefined }, { license: 'UNLICENSED' }, { version: 'latest' },
    { bin: { '../router': 'bin/switchboard.mjs' } },
  ]) {
    const tarball = await archive(t, { ...manifest, ...change });
    const result = spawnSync(process.execPath, [generator, tarball], { encoding: 'utf8' });
    assert.equal(result.status, 1, JSON.stringify(change));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /release metadata/i);
  }
});

test('Homebrew metadata cannot interpolate Ruby expressions into the generated formula', async t => {
  const tarball = await archive(t, { ...manifest, description: 'Text "quoted" #{exit(99)} #$secret' });
  const result = spawnSync(process.execPath, [generator, tarball], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('\\#{exit(99)}'));
  assert.ok(result.stdout.includes('\\#$secret'));
});
