import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SmartBillClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import {
  resolveCif,
  savePdf,
  toCallToolResult,
  withCif,
  withStatusHint,
} from '../src/tools/shared.ts';

test('resolveCif prefers the argument over the environment', () => {
  const config = loadConfig({ SMARTBILL_CIF: 'ENV' });
  assert.equal(resolveCif(config, 'ARG'), 'ARG');
});

test('resolveCif falls back to the environment', () => {
  assert.equal(resolveCif(loadConfig({ SMARTBILL_CIF: 'ENV' })), 'ENV');
});

test('resolveCif errors when neither is present, naming both routes', () => {
  const result = resolveCif(loadConfig({}));
  assert.notEqual(typeof result, 'string');
  if (typeof result !== 'string') {
    assert.match(result.hint ?? '', /SMARTBILL_CIF/);
    assert.match(result.hint ?? '', /cif/);
  }
});

test('withCif makes no HTTP call when no cif is available from either the argument or the environment', async () => {
  let called = false;
  const run = withCif(async () => {
    called = true;
    return { ok: true, data: {} };
  });
  const config = loadConfig({ SMARTBILL_CIF: '' });
  const outcome = await run({ client: {} as unknown as SmartBillClient, config }, {});
  assert.equal(outcome.ok, false);
  assert.equal(called, false);
});

test('toCallToolResult marks failures with isError and renders the param', () => {
  const r = toCallToolResult({
    ok: false,
    error: {
      message: 'bad field',
      code: 'json_mapping_error',
      param: 'products[0].quantity',
      httpStatus: 400,
    },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /products\[0\]\.quantity/);
  assert.match(r.content[0]!.text, /json_mapping_error/);
});

test('toCallToolResult renders every error of a multi-error response', () => {
  const r = toCallToolResult({
    ok: false,
    error: {
      message: 'must not be blank',
      httpStatus: 400,
      details: [{ param: 'name' }, { param: 'email' }],
    },
  });
  assert.match(r.content[0]!.text, /name/);
  assert.match(r.content[0]!.text, /email/);
});

test('toCallToolResult passes success data through as structuredContent', () => {
  const r = toCallToolResult({ ok: true, data: { number: '3593', series: 'fac' } });
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.structuredContent, { number: '3593', series: 'fac' });
});

test('savePdf writes the bytes and sanitises the filename', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  const result = await savePdf(dir, 'fac/2026 001.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  assert.equal(result.bytes, 4);
  assert.equal(result.path, join(dir, 'fac_2026_001.pdf'));
  assert.equal((await readFile(result.path)).toString('latin1'), '%PDF');
});

test('savePdf rejects a filename that sanitises to ".." rather than writing outside dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  await assert.rejects(() => savePdf(dir, '..', new Uint8Array([1])));
});

test('savePdf keeps a slash-based traversal attempt inside dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-'));
  const result = await savePdf(dir, '../../etc/passwd', new Uint8Array([1]));
  assert.equal(result.path, join(dir, '.._.._etc_passwd'));
});

test('withStatusHint replaces the hint only when the status matches, leaving other fields alone', () => {
  const failure = {
    ok: false as const,
    error: { message: 'boom', httpStatus: 502, hint: 'generic hint' },
    status: 502,
    rateLimit: {},
  };
  const patched = withStatusHint(failure, 502, 'specific hint');
  assert.equal(patched.ok, false);
  if (!patched.ok) {
    assert.equal(patched.error.hint, 'specific hint');
    assert.equal(patched.error.message, 'boom');
  }
});

test('withStatusHint leaves a non-matching status or a success untouched', () => {
  const wrongStatus = {
    ok: false as const,
    error: { message: 'boom', httpStatus: 400 },
    status: 400,
    rateLimit: {},
  };
  assert.equal(withStatusHint(wrongStatus, 502, 'specific hint'), wrongStatus);

  const success = { ok: true as const, data: {}, status: 200, rateLimit: {} };
  assert.equal(withStatusHint(success, 200, 'specific hint'), success);
});
