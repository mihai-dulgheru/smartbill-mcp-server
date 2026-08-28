import assert from 'node:assert/strict';
import test from 'node:test';
import { SmartBillClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import type { Clock } from '../src/ratelimit.ts';
import { paymentTools } from '../src/tools/payments.ts';
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
  const found = paymentTools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not found`);
  return found;
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

test('there are exactly four payment tools, all smartbill_-prefixed', () => {
  assert.equal(paymentTools.length, 4);
  for (const t of paymentTools) assert.match(t.name, /^smartbill_/);
});

test('create_payment injects companyVatCode', async () => {
  const { ctx, calls } = harness(json({ errorText: '', number: '7' }));
  await tool('smartbill_create_payment').run(ctx, {
    payment: {
      type: 'Ordin plata',
      value: 119,
      invoicesList: [{ seriesName: 'fac', number: '3593' }],
    },
  });
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.companyVatCode, 'RO123');
  assert.equal(body.type, 'Ordin plata');
});

test('companyVatCode is appended last, so it cannot be spoofed via the payment payload', async () => {
  const { ctx, calls } = harness(json({ errorText: '', number: '7' }));
  await tool('smartbill_create_payment').run(ctx, {
    payment: { type: 'Ordin plata', companyVatCode: 'RO_SPOOFED', value: 119 },
  });
  assert.equal(JSON.parse(String(calls[0]!.init.body)).companyVatCode, 'RO123');
});

test('delete_payment omits the optional identifiers that were not supplied', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }));
  await tool('smartbill_delete_payment').run(ctx, {
    paymentType: 'Ordin plata',
    invoiceSeries: 'fac',
    invoiceNumber: '3593',
  });
  const url = new URL(calls[0]!.url);
  assert.equal(calls[0]!.init.method, 'DELETE');
  assert.equal(url.searchParams.get('paymentType'), 'Ordin plata');
  assert.equal(url.searchParams.has('clientName'), false);
  assert.equal(url.searchParams.has('paymentValue'), false);
});

test('delete_payment rejects Chitanta and Bon paymentTypes at the schema level', () => {
  const schema = tool('smartbill_delete_payment').inputSchema;
  assert.equal(schema.safeParse({ paymentType: 'Chitanta' }).success, false);
  assert.equal(schema.safeParse({ paymentType: 'Bon' }).success, false);
  assert.equal(schema.safeParse({ paymentType: 'Ordin plata' }).success, true);
});

test('delete_receipt targets /payment/chitanta', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }));
  await tool('smartbill_delete_receipt').run(ctx, { seriesname: 'CH', number: '7' });
  assert.equal(new URL(calls[0]!.url).pathname, '/SBORO/api/payment/chitanta');
  assert.equal(calls[0]!.init.method, 'DELETE');
});

test('both delete tools are marked destructive and the read tool is read-only', () => {
  const destructive = paymentTools
    .filter((t) => t.annotations?.destructiveHint === true)
    .map((t) => t.name);
  assert.deepEqual(destructive.sort(), ['smartbill_delete_payment', 'smartbill_delete_receipt']);
  assert.equal(tool('smartbill_get_payment_receipt_text').annotations?.readOnlyHint, true);
});

test('the receipt-text tool sends id as a query parameter', async () => {
  const { ctx, calls } = harness(json({ errorText: '', message: 'Qm9u' }));
  await tool('smartbill_get_payment_receipt_text').run(ctx, { id: 20363 });
  assert.equal(new URL(calls[0]!.url).searchParams.get('id'), '20363');
});

test('the receipt-text tool on a 500 HTML response gets an invalid-id hint, not the misspelled-field hint', async () => {
  const html = new Response('<html><body>500</body></html>', {
    status: 500,
    headers: { 'content-type': 'text/html' },
  });
  const { ctx } = harness(html);
  const outcome = await tool('smartbill_get_payment_receipt_text').run(ctx, { id: 999999 });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(outcome.error.hint ?? '', /invalid/i);
    assert.doesNotMatch(outcome.error.hint ?? '', /field name/i);
  }
});

test('a tool called with no cif anywhere fails without an HTTP call', async () => {
  const { ctx, calls } = harness(json({ errorText: '' }), { SMARTBILL_CIF: '' });
  const outcome = await tool('smartbill_delete_receipt').run(ctx, {
    seriesname: 'CH',
    number: '7',
  });
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 0);
});
