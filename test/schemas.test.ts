import test from 'node:test';
import assert from 'node:assert/strict';
import {
  invoiceRequestSchema,
  productSchema,
  paginationSchema,
  deletablePaymentTypeEnum,
} from '../src/schemas.ts';

test('a minimal invoice passes validation', () => {
  const parsed = invoiceRequestSchema.safeParse({
    seriesName: 'fac',
    client: { name: 'Client Test SRL', country: 'Romania' },
    products: [
      { name: 'Produs', quantity: 1, price: 100, measuringUnitName: 'buc', taxPercentage: 21 },
    ],
  });
  assert.equal(parsed.success, true);
});

test('an invoice with no products is rejected', () => {
  const parsed = invoiceRequestSchema.safeParse({
    seriesName: 'fac',
    client: { name: 'X', country: 'Romania' },
    products: [],
  });
  assert.equal(parsed.success, false);
});

test('taxPercentage must be a number, not a percentage string', () => {
  const parsed = productSchema.safeParse({
    name: 'P', quantity: 1, price: 10, measuringUnitName: 'buc', taxPercentage: '21%',
  });
  assert.equal(parsed.success, false);
});

test('pagination limit is bounded to 1-100', () => {
  assert.equal(paginationSchema.safeParse({ limit: 100 }).success, true);
  assert.equal(paginationSchema.safeParse({ limit: 0 }).success, false);
  assert.equal(paginationSchema.safeParse({ limit: 101 }).success, false);
});

test('Chitanta is not a deletable payment type', () => {
  assert.equal(deletablePaymentTypeEnum.safeParse('Chitanta').success, false);
  assert.equal(deletablePaymentTypeEnum.safeParse('Ordin plata').success, true);
});
