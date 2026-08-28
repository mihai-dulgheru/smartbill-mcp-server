import assert from 'node:assert/strict';
import test from 'node:test';
import { SmartBillClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import type { Clock } from '../src/ratelimit.ts';
import { toCallToolResult, type ToolContext } from '../src/tools/shared.ts';
import { v3Tools } from '../src/tools/v3.ts';

const noWaitClock: Clock = { now: () => Date.now(), sleep: async () => {} };

function harness(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return response.clone();
  }) as unknown as typeof fetch;
  const config = loadConfig({
    SMARTBILL_V3_TOKEN: 'sb_live_x',
    SMARTBILL_CIF: 'RO123',
    SMARTBILL_BASE_URL: 'https://api.test/SBORO/api',
  });
  const ctx: ToolContext = {
    client: new SmartBillClient(config, { fetchImpl: impl, clock: noWaitClock }),
    config,
  };
  return { ctx, calls };
}

const tool = (name: string) => {
  const found = v3Tools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not found`);
  return found;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('there are eight V3 tools and all are read-only', () => {
  assert.equal(v3Tools.length, 8);
  for (const t of v3Tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} should be read-only`);
    assert.equal(t.api, 'v3');
    assert.match(t.name, /^smartbill_v3_/);
  }
});

test('list tools build the /v3/companies/{cif}/{resource} path', async () => {
  const { ctx, calls } = harness(json({ items: [], pagination: { next: null, previous: null } }));
  await tool('smartbill_v3_list_clients').run(ctx, {});
  assert.equal(new URL(calls[0]!.url).pathname, '/SBORO/api/v3/companies/RO123/clients');
});

test('get tools append the id to the path', async () => {
  const { ctx, calls } = harness(json({ id: 'ware_abc', name: 'Depozit' }));
  await tool('smartbill_v3_get_warehouse').run(ctx, { id: 'ware_abc' });
  assert.equal(
    new URL(calls[0]!.url).pathname,
    '/SBORO/api/v3/companies/RO123/warehouses/ware_abc',
  );
});

test('V3 uses Bearer auth', async () => {
  const { ctx, calls } = harness(json({ items: [], pagination: {} }));
  await tool('smartbill_v3_list_products').run(ctx, {});
  assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), 'Bearer sb_live_x');
});

test('pagination and filter parameters are forwarded, absent ones omitted', async () => {
  const { ctx, calls } = harness(json({ items: [], pagination: {} }));
  await tool('smartbill_v3_list_clients').run(ctx, { limit: 5, after: 'cus_abc', name: 'Acme' });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get('limit'), '5');
  assert.equal(url.searchParams.get('after'), 'cus_abc');
  assert.equal(url.searchParams.get('name'), 'Acme');
  assert.equal(url.searchParams.has('before'), false);
  assert.equal(url.searchParams.has('vatCode'), false);
});

test('after and before together are rejected without an HTTP call', async () => {
  const { ctx, calls } = harness(json({ items: [] }));
  const outcome = await tool('smartbill_v3_list_clients').run(ctx, {
    after: 'cus_a',
    before: 'cus_b',
  });
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 0);
});

test('get tools reject an id with the wrong prefix, without an HTTP call', async () => {
  const { ctx, calls } = harness(json({ id: 'ware_abc' }));
  const outcome = await tool('smartbill_v3_get_warehouse').run(ctx, { id: 'cus_wrong_resource' });
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 0);
  if (!outcome.ok) assert.equal(outcome.error.code, 'malformed_id');
});

test('get tools reject a path-traversal id like ".." instead of letting it collapse onto another endpoint', async () => {
  const { ctx, calls } = harness(json({ id: 'ware_abc' }));
  const outcome = await tool('smartbill_v3_get_warehouse').run(ctx, { id: '..' });
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 0);
});

test('warehouses accept only the name filter', () => {
  const schema = tool('smartbill_v3_list_warehouses').inputSchema;
  assert.equal(schema.safeParse({ name: 'Depozit' }).success, true);
  assert.equal('vatCode' in schema.shape, false);
});

test('products accept name and code but not vatCode', () => {
  const schema = tool('smartbill_v3_list_products').inputSchema;
  assert.equal('code' in schema.shape, true);
  assert.equal('vatCode' in schema.shape, false);
});

test('limit outside 1-100 is rejected by the schema', () => {
  const schema = tool('smartbill_v3_list_products').inputSchema;
  assert.equal(schema.safeParse({ limit: 101 }).success, false);
  assert.equal(schema.safeParse({ limit: 100 }).success, true);
});

test('a V3 validation error surfaces every error element', async () => {
  const { ctx } = harness(
    json(
      {
        status: 400,
        type: 'validation_error',
        instance: '/api/v3/clients',
        errors: [
          { code: 'invalid_field_value', message: 'limit out of range', param: 'limit' },
          { code: 'malformed_id', message: 'bad cursor', param: 'after' },
        ],
      },
      400,
    ),
  );
  const result = toCallToolResult(await tool('smartbill_v3_list_clients').run(ctx, {}));
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /invalid_field_value/);
  assert.match(result.content[0]!.text, /malformed_id/);
});

test('missing the V3 token fails without an HTTP call', async () => {
  const calls: unknown[] = [];
  const impl = (async () => {
    calls.push(1);
    return json({});
  }) as unknown as typeof fetch;
  const config = loadConfig({ SMARTBILL_CIF: 'RO1' });
  const ctx: ToolContext = {
    client: new SmartBillClient(config, { fetchImpl: impl, clock: noWaitClock }),
    config,
  };
  const outcome = await tool('smartbill_v3_list_clients').run(ctx, {});
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 0);
});

test('a tool called with no cif anywhere fails without an HTTP call', async () => {
  const { ctx, calls } = harness(json({ items: [] }));
  const config = loadConfig({ SMARTBILL_V3_TOKEN: 'sb_live_x', SMARTBILL_CIF: '' });
  const outcome = await tool('smartbill_v3_get_client').run({ ...ctx, config }, { id: 'cus_1' });
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 0);
});
