import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SmartBillClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import type { Clock } from '../src/ratelimit.ts';
import { invoiceTools } from '../src/tools/invoices.ts';
import { toCallToolResult, type ToolContext } from '../src/tools/shared.ts';

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
  const found = invoiceTools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not found`);
  return found;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('there are exactly seven invoice tools, all smartbill_-prefixed', () => {
  assert.equal(invoiceTools.length, 7);
  for (const t of invoiceTools) assert.match(t.name, /^smartbill_/);
});

test('create_invoice injects companyVatCode from the environment cif', async () => {
  const { ctx, calls } = harness(json({ errorText: '', number: '3593', series: 'fac' }));
  const result = await tool('smartbill_create_invoice').run(ctx, {
    invoice: {
      seriesName: 'fac',
      client: { name: 'X SRL', country: 'Romania' },
      products: [{ name: 'P', quantity: 1, price: 100, measuringUnitName: 'buc', taxPercentage: 21 }],
    },
  });
  assert.equal(result.ok, true);
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.companyVatCode, 'RO123');
  assert.equal(body.seriesName, 'fac');
});

test('an explicit cif overrides the environment', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }));
  await tool('smartbill_create_invoice').run(ctx, {
    cif: 'RO999',
    invoice: { seriesName: 'fac', client: { name: 'X', country: 'Romania' }, products: [] },
  });
  assert.equal(JSON.parse(String(calls[0]!.init.body)).companyVatCode, 'RO999');
});

test('a create that returns errorText on HTTP 200 is reported as a tool error', async () => {
  const { ctx } = harness(json({ errorText: 'Seria nu a fost gasita!', documentId: -1 }));
  const outcome = await tool('smartbill_create_invoice').run(ctx, {
    invoice: { seriesName: 'nope', client: { name: 'X', country: 'Romania' }, products: [] },
  });
  const result = toCallToolResult(outcome);
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /Seria nu a fost gasita/);
});

test('cancel and delete build the right method and query', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }));
  await tool('smartbill_cancel_invoice').run(ctx, { seriesname: 'fac', number: '3593' });
  assert.equal(calls[0]!.init.method, 'PUT');
  assert.equal(new URL(calls[0]!.url).pathname, '/SBORO/api/invoice/cancel');
  assert.equal(new URL(calls[0]!.url).searchParams.get('seriesname'), 'fac');

  await tool('smartbill_delete_invoice').run(ctx, { seriesname: 'fac', number: '3593' });
  assert.equal(calls[1]!.init.method, 'DELETE');
  assert.equal(new URL(calls[1]!.url).pathname, '/SBORO/api/invoice');
});

test('cancel_invoice against an already-cancelled invoice surfaces success, not a tool error', async () => {
  const { ctx } = harness(json({ errorText: 'Factura este deja anulata.' }));
  const outcome = await tool('smartbill_cancel_invoice').run(ctx, { seriesname: 'fac', number: '3593' });
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.match(String((outcome.data as { errorText: string }).errorText), /anulata/);
});

test('only delete_invoice is marked destructive', () => {
  const destructive = invoiceTools.filter((t) => t.annotations?.destructiveHint === true);
  assert.deepEqual(destructive.map((t) => t.name), ['smartbill_delete_invoice']);
});

test('get_invoice_pdf writes a file and returns its path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-inv-'));
  const pdf = new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  });
  const { ctx } = harness(pdf, { SMARTBILL_DOWNLOAD_DIR: dir });
  const outcome = await tool('smartbill_get_invoice_pdf').run(ctx, {
    seriesname: 'fac',
    number: '3593',
  });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    const data = outcome.data as { path: string; bytes: number };
    assert.equal(data.path, join(dir, 'fac-3593.pdf'));
    assert.equal(data.bytes, 4);
  }
});

test('a tool called with no cif anywhere fails without an HTTP call', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }), { SMARTBILL_CIF: '' });
  const outcome = await tool('smartbill_cancel_invoice').run(ctx, { seriesname: 'fac', number: '1' });
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 0);
});
