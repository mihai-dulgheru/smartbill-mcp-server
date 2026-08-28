import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SmartBillClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import type { Clock } from '../src/ratelimit.ts';
import { estimateTools } from '../src/tools/estimates.ts';
import type { ToolContext } from '../src/tools/shared.ts';

const noWaitClock: Clock = { now: () => Date.now(), sleep: async () => {} };

function harness(response: Response, env: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return response.clone();
  }) as unknown as typeof fetch;
  const config = loadConfig({
    SMARTBILL_EMAIL: 'a@b.co',
    SMARTBILL_TOKEN: 'tok',
    SMARTBILL_CIF: 'RO123',
    SMARTBILL_BASE_URL: 'https://api.test/SBORO/api',
    ...env,
  });
  const ctx: ToolContext = {
    client: new SmartBillClient(config, { fetchImpl: impl, clock: noWaitClock }),
    config,
  };
  return { ctx, calls };
}

const tool = (name: string) => {
  const found = estimateTools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not found`);
  return found;
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('there are exactly six estimate tools, all smartbill_-prefixed', () => {
  assert.equal(estimateTools.length, 6);
  for (const t of estimateTools) assert.match(t.name, /^smartbill_/);
});

test('create_estimate posts to /estimate/v2 with the injected cif', async () => {
  const { ctx, calls } = harness(json({ errorText: '', number: '227' }));
  await tool('smartbill_create_estimate').run(ctx, {
    estimate: {
      seriesName: 'pro',
      client: { name: 'X SRL', country: 'Romania' },
      products: [{ name: 'P', quantity: 1, price: 50, measuringUnitName: 'buc', taxPercentage: 21 }],
    },
  });
  assert.equal(new URL(calls[0]!.url).pathname, '/SBORO/api/estimate/v2');
  assert.equal(JSON.parse(String(calls[0]!.init.body)).companyVatCode, 'RO123');
});

test('companyVatCode is appended last, so it cannot be spoofed via the estimate payload', async () => {
  const { ctx, calls } = harness(json({ errorText: '', number: '227' }));
  await tool('smartbill_create_estimate').run(ctx, {
    estimate: {
      seriesName: 'pro',
      companyVatCode: 'RO_SPOOFED',
      client: { name: 'X SRL', country: 'Romania' },
      products: [],
    },
  });
  assert.equal(JSON.parse(String(calls[0]!.init.body)).companyVatCode, 'RO123');
});

test('get_estimate_invoices is a GET on /estimate/invoices', async () => {
  const { ctx, calls } = harness(json({ errorText: '', number: [] }));
  await tool('smartbill_get_estimate_invoices').run(ctx, { seriesname: 'pro', number: '227' });
  assert.equal(calls[0]!.init.method, 'GET');
  assert.equal(new URL(calls[0]!.url).pathname, '/SBORO/api/estimate/invoices');
});

test('cancel is PUT and delete is DELETE', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }));
  await tool('smartbill_cancel_estimate').run(ctx, { seriesname: 'pro', number: '227' });
  await tool('smartbill_delete_estimate').run(ctx, { seriesname: 'pro', number: '227' });
  assert.equal(calls[0]!.init.method, 'PUT');
  assert.equal(calls[1]!.init.method, 'DELETE');
});

test('cancel_estimate on a 200 with a genuinely non-empty errorText is still a tool error', async () => {
  // Same regression guard as cancel_invoice: cancelEstimate's spec 200 example is idempotent via
  // an empty errorText plus a message, not via errorTextIsInformational, so a real business
  // failure riding a 200 must still surface.
  const { ctx } = harness(json({ errorText: 'Nu aveti dreptul de a anula aceasta proforma.' }));
  const outcome = await tool('smartbill_cancel_estimate').run(ctx, { seriesname: 'pro', number: '227' });
  assert.equal(outcome.ok, false);
});

test('only delete_estimate is marked destructive; cancel and restore are idempotent, not destructive', () => {
  const destructive = estimateTools.filter((t) => t.annotations?.destructiveHint === true);
  assert.deepEqual(destructive.map((t) => t.name), ['smartbill_delete_estimate']);

  for (const name of ['smartbill_cancel_estimate', 'smartbill_restore_estimate']) {
    assert.equal(tool(name).annotations?.destructiveHint, false);
    assert.equal(tool(name).annotations?.idempotentHint, true);
  }
});

test('get_estimate_pdf writes a file named with the cif, series and number', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-est-'));
  const pdf = new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  });
  const { ctx } = harness(pdf, { SMARTBILL_DOWNLOAD_DIR: dir });
  const outcome = await tool('smartbill_get_estimate_pdf').run(ctx, { seriesname: 'pro', number: '227' });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    const data = outcome.data as { path: string; bytes: number };
    assert.equal(data.path, join(dir, 'RO123-pro-227.pdf'));
    assert.equal(data.bytes, 4);
  }
});

test('get_estimate_pdf treats a zero-length body as a failure, not a 0-byte file', async () => {
  const empty = new Response(new Uint8Array([]), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  });
  const { ctx } = harness(empty);
  const outcome = await tool('smartbill_get_estimate_pdf').run(ctx, { seriesname: 'pro', number: '227' });
  assert.equal(outcome.ok, false);
});

test('a tool called with no cif anywhere fails without an HTTP call', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }), { SMARTBILL_CIF: '' });
  const outcome = await tool('smartbill_cancel_estimate').run(ctx, { seriesname: 'pro', number: '1' });
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 0);
});
