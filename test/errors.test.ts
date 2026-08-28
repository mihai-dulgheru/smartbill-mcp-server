import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeError, stripHtml, networkError } from '../src/errors.ts';

const JSON_CT = 'application/json';

test('a 200 with an empty errorText is success', () => {
  assert.equal(normalizeError(200, JSON_CT, { errorText: '', number: '3593' }), null);
});

test('a 200 with a non-empty errorText is a failure', () => {
  const err = normalizeError(200, JSON_CT, {
    errorText: 'Seria nu a fost gasita! Folositi o serie creata in contul de cloud.',
    documentId: -1,
  });
  assert.ok(err);
  assert.equal(err.httpStatus, 200);
  assert.match(err.message, /Seria nu a fost gasita/);
});

test('errorText containing HTML is truncated at the first tag', () => {
  const err = normalizeError(400, JSON_CT, {
    errorText: 'Nu ai facut nicio achizitie pentru produsul Mere.<br/>Verifica stocul.',
  });
  assert.ok(err);
  assert.equal(err.message, 'Nu ai facut nicio achizitie pentru produsul Mere.');
});

test('errorText with a hidden details div keeps only the leading sentence', () => {
  const err = normalizeError(400, JSON_CT, {
    errorText:
      'Unitatea de masura buc a produsului X nu are factor de conversie setat.' +
      '<div id="moreErrorDetails" style="display:none"><p>ajutor</p></div>',
  });
  assert.ok(err);
  assert.equal(
    err.message,
    'Unitatea de masura buc a produsului X nu are factor de conversie setat.',
  );
});

test('V1 invalid_request_error surfaces code and param', () => {
  const err = normalizeError(400, JSON_CT, {
    status: 400,
    type: 'invalid_request_error',
    instance: '/SBORO/api/invoice/v2',
    errors: [
      {
        code: 'json_mapping_error',
        message: 'Unrecognized property: zzz.',
        docUrl: 'https://api.smartbill.ro/#v3-error-invalid_request_error',
        param: 'zzz',
      },
    ],
  });
  assert.ok(err);
  assert.equal(err.code, 'json_mapping_error');
  assert.equal(err.type, 'invalid_request_error');
  assert.equal(err.param, 'zzz');
  assert.match(err.message, /Unrecognized property/);
});

test('a V3 body with two errors surfaces both', () => {
  const err = normalizeError(400, JSON_CT, {
    status: 400,
    type: 'validation_error',
    instance: '/api/v3/clients',
    errors: [
      { code: 'missing_required_field', message: 'must not be blank', param: 'name' },
      { code: 'invalid_field_format', message: 'must be a well-formed email address', param: 'email' },
    ],
  });
  assert.ok(err);
  assert.equal(err.code, 'missing_required_field');
  assert.equal(err.param, 'name');
  assert.equal(err.details?.length, 2);
  assert.match(err.message, /must not be blank/);
});

test('an HTML 500 is reported as a probable field-name typo, not a server fault', () => {
  const err = normalizeError(500, 'text/html;charset=utf-8', '<html><body>error</body></html>');
  assert.ok(err);
  assert.equal(err.httpStatus, 500);
  assert.match(err.hint ?? '', /field name/i);
});

test('a 4xx with no recognisable body still produces an error', () => {
  const err = normalizeError(404, JSON_CT, {});
  assert.ok(err);
  assert.equal(err.httpStatus, 404);
});

test('a 2xx with no errorText and no error envelope is success', () => {
  assert.equal(normalizeError(200, JSON_CT, { list: [{ name: 'fac' }] }), null);
});

test('stripHtml keeps text before the first tag and collapses whitespace', () => {
  assert.equal(stripHtml('  Cauza reala.  <b>x</b> rest'), 'Cauza reala.');
  assert.equal(stripHtml('fara marcaje'), 'fara marcaje');
});

test('networkError reports httpStatus 0', () => {
  const err = networkError(new Error('ECONNREFUSED'));
  assert.equal(err.httpStatus, 0);
  assert.match(err.message, /ECONNREFUSED/);
});
