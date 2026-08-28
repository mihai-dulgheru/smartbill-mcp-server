import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { allTools } from '../src/tools/index.ts';

type SpecOperation = { operationId?: string; security?: Array<Record<string, unknown>> };
type Spec = { paths: Record<string, Record<string, SpecOperation>> };

const METHODS = ['get', 'post', 'put', 'delete', 'patch'];

async function loadSpec(): Promise<Spec> {
  const raw = await readFile(new URL('../docs/smartbill-openapi-spec.json', import.meta.url), 'utf8');
  return JSON.parse(raw) as Spec;
}

/** Every operationId in the spec, with the auth scheme its security block names. */
async function specOperations(): Promise<Map<string, 'v1' | 'v3'>> {
  const spec = await loadSpec();
  const ops = new Map<string, 'v1' | 'v3'>();
  for (const methods of Object.values(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (!METHODS.includes(method) || !op.operationId) continue;
      const usesBearer = (op.security ?? []).some((s) => 'bearerAuth' in s);
      ops.set(op.operationId, usesBearer ? 'v3' : 'v1');
    }
  }
  return ops;
}

test('the spec still has 29 operations', async () => {
  assert.equal((await specOperations()).size, 29);
});

test('no spec operation is missing a tool', async () => {
  const ops = await specOperations();
  const covered = new Set(allTools.map((t) => t.operationId));
  const missing = [...ops.keys()].filter((id) => !covered.has(id));
  assert.deepEqual(missing, [], `operations with no tool: ${missing.join(', ')}`);
});

test('every tool maps to a real spec operation', async () => {
  const ops = await specOperations();
  const unknown = allTools.filter((t) => !ops.has(t.operationId)).map((t) => t.operationId);
  assert.deepEqual(unknown, [], `tools referencing no spec operation: ${unknown.join(', ')}`);
});

test('no operationId is claimed by two tools', () => {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const t of allTools) {
    if (seen.has(t.operationId)) duplicates.push(t.operationId);
    seen.add(t.operationId);
  }
  assert.deepEqual(duplicates, []);
});

test('each tool declares the api version its spec security block requires', async () => {
  const ops = await specOperations();
  for (const t of allTools) {
    assert.equal(t.api, ops.get(t.operationId), `${t.name} declares api ${t.api}`);
  }
});

test('tool names are unique and smartbill_-prefixed', () => {
  const names = allTools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.match(n, /^smartbill_[a-z0-9_]+$/);
});

test('every tool has a title and a description of real substance', () => {
  for (const t of allTools) {
    assert.ok(t.title.length > 0, `${t.name} has no title`);
    assert.ok(t.description.length > 40, `${t.name} has a thin description`);
  }
});

test('exactly four tools are marked destructive, and they are the deletes', () => {
  const destructive = allTools
    .filter((t) => t.annotations?.destructiveHint === true)
    .map((t) => t.name)
    .sort();
  assert.deepEqual(destructive, [
    'smartbill_delete_estimate',
    'smartbill_delete_invoice',
    'smartbill_delete_payment',
    'smartbill_delete_receipt',
  ]);
});

test('sixteen tools are read-only, and they are the reads', () => {
  // 2 invoice + 2 estimate + 1 payment + 3 company + 8 V3.
  const readOnly = allTools
    .filter((t) => t.annotations?.readOnlyHint === true)
    .map((t) => t.name)
    .sort();
  assert.deepEqual(readOnly, [
    'smartbill_get_estimate_invoices',
    'smartbill_get_estimate_pdf',
    'smartbill_get_invoice_payment_status',
    'smartbill_get_invoice_pdf',
    'smartbill_get_payment_receipt_text',
    'smartbill_get_series',
    'smartbill_get_stocks',
    'smartbill_get_tax_and_series',
    'smartbill_v3_get_client',
    'smartbill_v3_get_product',
    'smartbill_v3_get_supplier',
    'smartbill_v3_get_warehouse',
    'smartbill_v3_list_clients',
    'smartbill_v3_list_products',
    'smartbill_v3_list_suppliers',
    'smartbill_v3_list_warehouses',
  ]);
});

test('there are 29 tools in total', () => {
  assert.equal(allTools.length, 29);
});
