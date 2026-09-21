import assert from 'node:assert/strict';
import test from 'node:test';
import { canChangeEffort, parseCatalog } from '../src/core/catalog.ts';
import { catalogFixture, environment } from './fixtures.ts';

test('adaptive effort needs an exact verified integration match', () => {
  const catalog = parseCatalog(catalogFixture());
  assert.equal(canChangeEffort(catalog, environment), true);
  for (const mismatch of [
    { cliVersion: '1.2.4' }, { connection: 'api-key' as const },
    { model: 'fixture-strong' }, { mode: 'multi-agent' },
  ]) assert.equal(canChangeEffort(catalog, { ...environment, ...mismatch }), false);
});

test('documentation and an effort mechanism alone are not verification', () => {
  const catalog = catalogFixture();
  catalog.compatibility[0]!.status = 'unverified';
  assert.equal(canChangeEffort(parseCatalog(catalog), environment), false);
});

test('an unenforced compatibility restriction cannot enable adaptive effort', () => {
  const catalog = catalogFixture();
  catalog.compatibility[0]!.restrictions = ['Requires a compaction mode the adapter has not checked'];
  assert.equal(canChangeEffort(parseCatalog(catalog), environment), false);
});

test('verified records must have evidence and cannot use a fixed-effort mechanism', () => {
  const missing = catalogFixture();
  missing.compatibility[0]!.evidence = null;
  assert.throws(() => parseCatalog(missing), /evidence/i);
  const fixed = catalogFixture();
  fixed.compatibility[0]!.mechanism = 'fixed';
  assert.equal(canChangeEffort(parseCatalog(fixed), environment), false);
});

test('duplicate model IDs for one tool and unsupported compatibility models fail validation', () => {
  const duplicate = catalogFixture();
  duplicate.models.push({ ...duplicate.models[0]! });
  assert.throws(() => parseCatalog(duplicate), /duplicate/i);
  const wrong = catalogFixture();
  wrong.compatibility[0]!.model = 'absent';
  assert.throws(() => parseCatalog(wrong), /model/i);
});
