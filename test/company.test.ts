import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartBillClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import type { Clock } from '../src/ratelimit.ts';
import { companyTools } from '../src/tools/company.ts';
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
  const found = companyTools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not found`);
  return found;
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

test('there are exactly four company tools, all smartbill_-prefixed', () => {
  assert.equal(companyTools.length, 4);
  for (const t of companyTools) assert.match(t.name, /^smartbill_/);
});

test('get_tax_and_series is a GET on /tax', async () => {
  const { ctx, calls } = harness(json({ errorText: '', taxes: [] }));
  await tool('smartbill_get_tax_and_series').run(ctx, {});
  assert.equal(calls[0]!.init.method, 'GET');
  assert.equal(new URL(calls[0]!.url).pathname, '/SBORO/api/tax');
});

test('get_series passes the type filter through and omits it when absent', async () => {
  const { ctx, calls } = harness(json({ errorText: '', list: [] }));
  await tool('smartbill_get_series').run(ctx, { type: 'f' });
  assert.equal(new URL(calls[0]!.url).searchParams.get('type'), 'f');

  await tool('smartbill_get_series').run(ctx, {});
  assert.equal(new URL(calls[1]!.url).searchParams.has('type'), false);
});

test('get_series rejects a type outside f/p/c', () => {
  assert.equal(tool('smartbill_get_series').inputSchema.safeParse({ type: 'x' }).success, false);
  assert.equal(tool('smartbill_get_series').inputSchema.safeParse({ type: 'p' }).success, true);
});

test('get_stocks requires a date', () => {
  assert.equal(tool('smartbill_get_stocks').inputSchema.safeParse({}).success, false);
  assert.equal(
    tool('smartbill_get_stocks').inputSchema.safeParse({ date: '2026-07-11' }).success,
    true,
  );
});

test('get_stocks sends the optional filters only when supplied', async () => {
  const { ctx, calls } = harness(json({ errorText: '', list: [] }));
  await tool('smartbill_get_stocks').run(ctx, { date: '2026-07-11', warehouseName: 'Depozit' });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get('date'), '2026-07-11');
  assert.equal(url.searchParams.get('warehouseName'), 'Depozit');
  assert.equal(url.searchParams.has('productCode'), false);
});

test('send_document_email posts the document with the injected cif', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }));
  await tool('smartbill_send_document_email').run(ctx, {
    document: { seriesName: 'fac', number: '3593', type: 'factura' },
  });
  assert.equal(new URL(calls[0]!.url).pathname, '/SBORO/api/document/send');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.companyVatCode, 'RO123');
  assert.equal(body.type, 'factura');
});

test('companyVatCode is appended last, so it cannot be spoofed via the document payload', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }));
  await tool('smartbill_send_document_email').run(ctx, {
    document: { seriesName: 'fac', number: '3593', type: 'factura', companyVatCode: 'RO_SPOOFED' },
  });
  assert.equal(JSON.parse(String(calls[0]!.init.body)).companyVatCode, 'RO123');
});

test('the three read tools are marked read-only and email is not', () => {
  const readOnly = companyTools
    .filter((t) => t.annotations?.readOnlyHint === true)
    .map((t) => t.name);
  assert.equal(readOnly.length, 3);
  assert.equal(tool('smartbill_send_document_email').annotations?.readOnlyHint, undefined);
});

test('a tool called with no cif anywhere fails without an HTTP call', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }), { SMARTBILL_CIF: '' });
  const outcome = await tool('smartbill_get_tax_and_series').run(ctx, {});
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 0);
});
