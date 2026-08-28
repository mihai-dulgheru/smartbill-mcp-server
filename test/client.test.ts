import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartBillClient } from '../src/client.ts';
import type { Clock } from '../src/ratelimit.ts';
import { loadConfig } from '../src/config.ts';

const config = loadConfig({
  SMARTBILL_EMAIL: 'a@b.co',
  SMARTBILL_TOKEN: 'tok',
  SMARTBILL_V3_TOKEN: 'sb_live_x',
  SMARTBILL_BASE_URL: 'https://api.test/SBORO/api',
});

const noWaitClock: Clock = { now: () => Date.now(), sleep: async () => {} };

type Call = { url: string; init: RequestInit };

/** Returns a fetch stub plus the list of calls it received. */
function stubFetch(...responses: Response[]) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return r.clone();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const client = (f: typeof fetch) =>
  new SmartBillClient(config, { fetchImpl: f, clock: noWaitClock });

test('v1 uses Basic auth with base64 email:token', async () => {
  const { impl, calls } = stubFetch(json({ errorText: '' }));
  await client(impl).request({ api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' } });
  const auth = new Headers(calls[0]!.init.headers).get('authorization');
  assert.equal(auth, `Basic ${Buffer.from('a@b.co:tok').toString('base64')}`);
});

test('v3 uses Bearer auth', async () => {
  const { impl, calls } = stubFetch(json({ items: [], pagination: {} }));
  await client(impl).request({ api: 'v3', method: 'GET', path: '/v3/companies/RO1/clients' });
  const auth = new Headers(calls[0]!.init.headers).get('authorization');
  assert.equal(auth, 'Bearer sb_live_x');
});

test('builds the query string and drops undefined and null', async () => {
  const { impl, calls } = stubFetch(json({ errorText: '' }));
  await client(impl).request({
    api: 'v1',
    method: 'GET',
    path: '/stocks',
    query: { cif: 'RO1', date: '2026-07-11', warehouseName: undefined, productCode: null, limit: 5, flag: true },
  });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, '/SBORO/api/stocks');
  assert.equal(url.searchParams.get('cif'), 'RO1');
  assert.equal(url.searchParams.get('limit'), '5');
  assert.equal(url.searchParams.get('flag'), 'true');
  assert.equal(url.searchParams.has('warehouseName'), false);
  assert.equal(url.searchParams.has('productCode'), false);
});

test('sends Content-Type only when there is a body', async () => {
  const { impl, calls } = stubFetch(json({ errorText: '' }));
  const c = client(impl);
  await c.request({ api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' } });
  assert.equal(new Headers(calls[0]!.init.headers).get('content-type'), null);

  await c.request({ api: 'v1', method: 'POST', path: '/invoice/v2', body: { companyVatCode: 'RO1' } });
  assert.equal(new Headers(calls[1]!.init.headers).get('content-type'), 'application/json');
  assert.equal(calls[1]!.init.body, JSON.stringify({ companyVatCode: 'RO1' }));
});

test('a 200 carrying errorText is returned as a failure', async () => {
  const { impl } = stubFetch(json({ errorText: 'Seria nu a fost gasita!', documentId: -1 }));
  const res = await client(impl).request({ api: 'v1', method: 'POST', path: '/invoice/v2', body: {} });
  assert.equal(res.ok, false);
  assert.equal(res.status, 200);
  if (!res.ok) assert.match(res.error.message, /Seria nu a fost gasita/);
});

test('...unless the request opts in with errorTextIsInformational, which turns a 200 into a success and keeps the message', async () => {
  const { impl } = stubFetch(json({ errorText: 'Proforma cu seria pro si numarul 226 nu a fost facturata.', areInvoicesCreated: false }));
  const res = await client(impl).request({
    api: 'v1',
    method: 'GET',
    path: '/estimate/invoices',
    query: { cif: 'RO1' },
    errorTextIsInformational: true,
  });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  if (res.ok) {
    const data = res.data as { errorText: string; areInvoicesCreated: boolean };
    assert.match(data.errorText, /nu a fost facturata/);
    assert.equal(data.areInvoicesCreated, false);
  }
});

test('errorTextIsInformational never relaxes a non-200 response — only HTTP 200 is exempt', async () => {
  const { impl } = stubFetch(
    json({ errorText: 'Nu poti sterge documentul cu seria si numarul CH 0003, deoarece nu este ultimul din serie!' }, 403),
  );
  const res = await client(impl).request({
    api: 'v1',
    method: 'PUT',
    path: '/estimate/cancel',
    query: { cif: 'RO1' },
    errorTextIsInformational: true,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.httpStatus, 403);
});

test('a mixed-case Content-Type is still decoded as JSON', async () => {
  const { impl } = stubFetch(
    new Response(JSON.stringify({ errorText: '' }), { status: 200, headers: { 'content-type': 'Application/JSON' } }),
  );
  const res = await client(impl).request({ api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' } });
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.data, { errorText: '' });
});

test('an unparseable JSON body is reported as a real HTTP failure, not a network error', async () => {
  const { impl } = stubFetch(
    new Response('{not valid json', { status: 502, headers: { 'content-type': 'application/json' } }),
  );
  const res = await client(impl).request({ api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' } });
  assert.equal(res.ok, false);
  assert.equal(res.status, 502);
  if (!res.ok) {
    assert.equal(res.error.httpStatus, 502);
    assert.doesNotMatch(res.error.message, /reach SmartBill/i);
    assert.doesNotMatch(res.error.hint ?? '', /connectivity/i);
  }
});

test('parses rate-limit headers', async () => {
  const { impl } = stubFetch(
    json({ errorText: '' }, 200, {
      'x-ratelimit-limit': '30',
      'x-ratelimit-remaining': '29',
      'x-ratelimit-reset': '1790000000',
      'x-ratelimit-daily-limit': '50000',
      'x-ratelimit-daily-remaining': '49999',
    }),
  );
  const res = await client(impl).request({ api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' } });
  assert.equal(res.rateLimit.limit, 30);
  assert.equal(res.rateLimit.remaining, 29);
  assert.equal(res.rateLimit.reset, 1790000000);
  assert.equal(res.rateLimit.dailyLimit, 50000);
});

test('binary responses come back as bytes', async () => {
  const pdf = new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  });
  const { impl } = stubFetch(pdf);
  const res = await client(impl).request({
    api: 'v1', method: 'GET', path: '/invoice/pdf', query: { cif: 'RO1' }, binary: true,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.bytes?.length, 4);
    assert.equal(Buffer.from(res.bytes!).toString('latin1'), '%PDF');
  }
});

test('a binary endpoint that returns JSON is decoded as an error', async () => {
  const { impl } = stubFetch(json({ errorText: 'Numarul facturii trebuie specificat' }, 400));
  const res = await client(impl).request({
    api: 'v1', method: 'GET', path: '/invoice/pdf', query: { cif: 'RO1' }, binary: true,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error.message, /Numarul facturii/);
});

test('the binary branch still fails on a non-2xx octet-stream response', async () => {
  const { impl } = stubFetch(
    new Response(new Uint8Array([1, 2, 3]), { status: 500, headers: { 'content-type': 'application/octet-stream' } }),
  );
  const res = await client(impl).request({
    api: 'v1', method: 'GET', path: '/invoice/pdf', query: { cif: 'RO1' }, binary: true,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.httpStatus, 500);
});

test('an HTML 500 becomes the field-name hint', async () => {
  const { impl } = stubFetch(
    new Response('<html>500</html>', { status: 500, headers: { 'content-type': 'text/html' } }),
  );
  const res = await client(impl).request({ api: 'v1', method: 'POST', path: '/invoice/v2', body: {} });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error.hint ?? '', /field name/i);
});

test('a 429 with Retry-After is retried exactly once', async () => {
  const { impl, calls } = stubFetch(
    json({ status: 429, type: 'invalid_request_error', errors: [{ code: 'rate_limit_exceeded', message: 'slow down' }] }, 429, { 'retry-after': '2' }),
    json({ errorText: '', number: '1' }),
  );
  const slept: number[] = [];
  const clock: Clock = { now: () => Date.now(), sleep: async (ms) => { slept.push(ms); } };
  const res = await new SmartBillClient(config, { fetchImpl: impl, clock }).request({
    api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' },
  });
  assert.equal(calls.length, 2);
  assert.equal(res.ok, true);
  assert.deepEqual(slept, [2000]);
});

test('a Retry-After above the ceiling errors instead of sleeping', async () => {
  const { impl, calls } = stubFetch(
    json({ status: 429, type: 'invalid_request_error', errors: [{ code: 'rate_limit_exceeded', message: 'blocked' }] }, 429, { 'retry-after': '600' }),
  );
  const res = await client(impl).request({ api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' } });
  assert.equal(calls.length, 1);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.code, 'rate_limit_exceeded');
    assert.match(res.error.hint ?? '', /600/);
  }
});

test('a 400 is never retried', async () => {
  const { impl, calls } = stubFetch(json({ errorText: 'bad' }, 400));
  await client(impl).request({ api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' } });
  assert.equal(calls.length, 1);
});

test('a fetch rejection becomes a status-0 error', async () => {
  const impl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const res = await client(impl).request({ api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' } });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.httpStatus, 0);
});

test('missing credentials fail before any HTTP call', async () => {
  const bare = loadConfig({});
  const { impl, calls } = stubFetch(json({ errorText: '' }));
  const res = await new SmartBillClient(bare, { fetchImpl: impl, clock: noWaitClock }).request({
    api: 'v1', method: 'GET', path: '/tax', query: { cif: 'RO1' },
  });
  assert.equal(calls.length, 0);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error.message, /SMARTBILL_EMAIL/);
});
