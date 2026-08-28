import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { loadConfig } from '../src/config.ts';

test('defaults baseUrl and downloadDir when unset', () => {
  const c = loadConfig({});
  assert.equal(c.baseUrl, 'https://ws.smartbill.ro/SBORO/api');
  assert.equal(c.downloadDir, tmpdir());
});

test('hasV1 requires both email and token', () => {
  assert.equal(loadConfig({}).hasV1, false);
  assert.equal(loadConfig({ SMARTBILL_EMAIL: 'a@b.co' }).hasV1, false);
  assert.equal(loadConfig({ SMARTBILL_TOKEN: 'tok' }).hasV1, false);
  assert.equal(loadConfig({ SMARTBILL_EMAIL: 'a@b.co', SMARTBILL_TOKEN: 'tok' }).hasV1, true);
});

test('hasV3 requires the v3 token', () => {
  assert.equal(loadConfig({}).hasV3, false);
  assert.equal(loadConfig({ SMARTBILL_V3_TOKEN: 'sb_x' }).hasV3, true);
});

test('trims values and treats blank strings as absent', () => {
  const c = loadConfig({ SMARTBILL_EMAIL: '  a@b.co ', SMARTBILL_TOKEN: '   ' });
  assert.equal(c.email, 'a@b.co');
  assert.equal(c.token, undefined);
  assert.equal(c.hasV1, false);
});

test('strips a trailing slash from baseUrl', () => {
  const c = loadConfig({ SMARTBILL_BASE_URL: 'https://example.test/api/' });
  assert.equal(c.baseUrl, 'https://example.test/api');
});
