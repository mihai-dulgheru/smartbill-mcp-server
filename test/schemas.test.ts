import test from 'node:test';
import assert from 'node:assert/strict';
import {
  invoiceRequestSchema,
  productSchema,
  paginationSchema,
  deletablePaymentTypeEnum,
  paymentRequestSchema,
  clientSchema,
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

test('discountType of 3 is rejected (API accepts it but produces wrong document)', () => {
  const parsed = productSchema.safeParse({
    name: 'P', quantity: 1, price: 100, measuringUnitName: 'buc', taxPercentage: 21,
    isDiscount: true, numberOfItems: 1, discountType: 3, discountValue: -10,
  });
  assert.equal(parsed.success, false);
});

test('discountValue must be negative; positive is rejected', () => {
  const positiveRejected = productSchema.safeParse({
    name: 'P', quantity: 1, price: 100, measuringUnitName: 'buc', taxPercentage: 21,
    discountValue: 10,
  });
  assert.equal(positiveRejected.success, false);

  const negativeAccepted = productSchema.safeParse({
    name: 'P', quantity: 1, price: 100, measuringUnitName: 'buc', taxPercentage: 21,
    discountValue: -10,
  });
  assert.equal(negativeAccepted.success, true);
});

test('discountPercentage is bounded: 101 and 0 are rejected; 10 is accepted', () => {
  assert.equal(
    productSchema.safeParse({
      name: 'P', quantity: 1, price: 100, measuringUnitName: 'buc', taxPercentage: 21,
      discountPercentage: 101,
    }).success,
    false,
  );

  assert.equal(
    productSchema.safeParse({
      name: 'P', quantity: 1, price: 100, measuringUnitName: 'buc', taxPercentage: 21,
      discountPercentage: 0,
    }).success,
    false,
  );

  assert.equal(
    productSchema.safeParse({
      name: 'P', quantity: 1, price: 100, measuringUnitName: 'buc', taxPercentage: 21,
      discountPercentage: 10,
    }).success,
    true,
  );
});

test('price cannot be negative', () => {
  const parsed = productSchema.safeParse({
    name: 'P', quantity: 1, price: -10, measuringUnitName: 'buc', taxPercentage: 21,
  });
  assert.equal(parsed.success, false);
});

test('estimate.useStock is preserved in parsed output', () => {
  const parsed = invoiceRequestSchema.safeParse({
    seriesName: 'fac',
    client: { name: 'Client Test SRL', country: 'Romania' },
    products: [
      { name: 'Produs', quantity: 1, price: 100, measuringUnitName: 'buc', taxPercentage: 21 },
    ],
    useEstimateDetails: true,
    estimate: { seriesName: 'prof', number: '1', useStock: true },
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.estimate?.useStock, true);
});

test('invoicesList accepts both single object and array', () => {
  const singleObject = paymentRequestSchema.safeParse({
    type: 'Ordin plata',
    invoicesList: { seriesName: 'fac', number: '1' },
  });
  assert.equal(singleObject.success, true);

  const arrayOfObjects = paymentRequestSchema.safeParse({
    type: 'Ordin plata',
    invoicesList: [{ seriesName: 'fac', number: '1' }, { seriesName: 'fac', number: '2' }],
  });
  assert.equal(arrayOfObjects.success, true);
});

test('Client.email must be a valid email', () => {
  const invalidEmail = clientSchema.safeParse({
    name: 'Test', country: 'Romania', email: 'not-an-email',
  });
  assert.equal(invalidEmail.success, false);

  const validEmail = clientSchema.safeParse({
    name: 'Test', country: 'Romania', email: 'test@example.com',
  });
  assert.equal(validEmail.success, true);
});

test('discountValue: 0 is rejected; -10 is accepted (exclusive maximum 0)', () => {
  const zero = productSchema.safeParse({
    name: 'P', quantity: 1, price: 100, measuringUnitName: 'buc', taxPercentage: 21,
    discountValue: 0,
  });
  assert.equal(zero.success, false);

  const negative = productSchema.safeParse({
    name: 'P', quantity: 1, price: 100, measuringUnitName: 'buc', taxPercentage: 21,
    discountValue: -10,
  });
  assert.equal(negative.success, true);
});
