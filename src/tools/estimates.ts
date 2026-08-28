import * as z from 'zod';
import { documentRefSchema, estimateRequestSchema } from '../schemas.ts';
import { cifArg, savePdf, withCif, type ToolDef } from './shared.ts';

const ACCOUNT_STRINGS =
  'seriesName, taxName and measuringUnitName must match values configured in the SmartBill account exactly and are never guessed — seriesName from smartbill_get_series, taxName from smartbill_get_tax_and_series, measuringUnitName from smartbill_get_stocks or smartbill_v3_list_products, or by asking the user.';

const docRef = { cif: cifArg, ...documentRefSchema.shape };

/**
 * Every estimate tool but create and pdf is the same shape: cif + series + number on one path.
 * `errorTextIsInformational` is opt-in per call site — of the operations here, only
 * getEstimateInvoices documents a 200 where `errorText` itself carries a purely informational
 * message ("...nu a fost facturata."), so only it passes the flag. cancelEstimate and
 * restoreEstimate are idempotent too, but per their spec examples that idempotency shows up as
 * `errorText: ""` with the message in `message` — an ordinary success already, needing no flag.
 * deleteEstimate gets neither: a real failure there must still surface.
 */
const simple = (
  name: string,
  operationId: string,
  title: string,
  description: string,
  method: 'GET' | 'PUT' | 'DELETE',
  path: string,
  annotations?: ToolDef['annotations'],
  errorTextIsInformational?: boolean,
): ToolDef => ({
  name,
  operationId,
  api: 'v1',
  title,
  description,
  inputSchema: z.object(docRef),
  ...(annotations ? { annotations } : {}),
  run: withCif(async ({ client }, args, cif) => {
    return client.request({
      api: 'v1',
      method,
      path,
      query: { cif, seriesname: args.seriesname as string, number: args.number as string },
      ...(errorTextIsInformational ? { errorTextIsInformational: true } : {}),
    });
  }),
});

export const estimateTools: ToolDef[] = [
  {
    name: 'smartbill_create_estimate',
    operationId: 'createEstimateV2',
    api: 'v1',
    title: 'Create proforma (estimate)',
    description:
      'Issue a proforma / estimate. Same product and client rules as an invoice: prices EXCLUDE VAT unless isTaxIncluded is true, and taxPercentage is a bare number. ' +
      ACCOUNT_STRINGS +
      ' A proforma does not generate accounting entries; convert it with smartbill_create_invoice using useEstimateDetails.',
    inputSchema: z.object({ cif: cifArg, estimate: estimateRequestSchema }),
    annotations: { destructiveHint: false, idempotentHint: false },
    run: withCif(async ({ client }, args, cif) => {
      const estimate = args.estimate as Record<string, unknown>;
      // companyVatCode last: unconditional override of any (impossible, but future-proof) same-named
      // key in the spread, rather than depending on the schema having stripped it first.
      return client.request({
        api: 'v1',
        method: 'POST',
        path: '/estimate/v2',
        body: { ...estimate, companyVatCode: cif },
      });
    }),
  },
  {
    name: 'smartbill_get_estimate_pdf',
    operationId: 'getEstimatePdf',
    api: 'v1',
    title: 'Download proforma PDF',
    description:
      'Download a proforma as PDF. The file is written to the server download directory and the tool returns its path and size.',
    inputSchema: z.object(docRef),
    annotations: { readOnlyHint: true },
    run: withCif(async ({ client, config }, args, cif) => {
      const res = await client.request({
        api: 'v1',
        method: 'GET',
        path: '/estimate/pdf',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
        binary: true,
      });
      if (!res.ok) return res;
      // A defined-but-empty body is just as unusable as a missing one — treat it the same way
      // rather than silently saving a 0-byte "PDF".
      if (!res.bytes || res.bytes.length === 0) {
        return { ok: false, error: { message: 'SmartBill returned no PDF content.', httpStatus: res.status } };
      }
      const saved = await savePdf(
        config.downloadDir,
        `${cif}-${args.seriesname}-${args.number}.pdf`,
        res.bytes,
      );
      return { ok: true, data: saved };
    }),
  },
  simple(
    'smartbill_get_estimate_invoices',
    'getEstimateInvoices',
    'List invoices issued from a proforma',
    'List the invoices that were created from a given proforma. Use it to check whether a proforma has already been invoiced before issuing another. ' +
      'If the proforma has not been invoiced yet, the call still succeeds and the response can carry a purely informational `errorText` (e.g. "...nu a fost facturata.") — that is not a failure. ' +
      'A draft invoice appears in the `invoices` list with an empty `number` and still sets `areInvoicesCreated: true`; ignore entries with an empty `number` when checking whether a real invoice has been issued, or an unfinished draft can be mistaken for a completed one.',
    'GET',
    '/estimate/invoices',
    { readOnlyHint: true },
    true,
  ),
  simple(
    'smartbill_cancel_estimate',
    'cancelEstimate',
    'Cancel proforma',
    'Mark a proforma as cancelled. Reversible with smartbill_restore_estimate. ' +
      'Idempotent: cancelling an already-cancelled proforma still succeeds, carrying an informational message rather than failing as a tool error.',
    'PUT',
    '/estimate/cancel',
    { destructiveHint: false, idempotentHint: true },
  ),
  simple(
    'smartbill_restore_estimate',
    'restoreEstimate',
    'Restore cancelled proforma',
    'Undo smartbill_cancel_estimate, returning the proforma to its active state. ' +
      'Idempotent: restoring a proforma that was never cancelled still succeeds, carrying an informational message rather than failing as a tool error.',
    'PUT',
    '/estimate/restore',
    { destructiveHint: false, idempotentHint: true },
  ),
  simple(
    'smartbill_delete_estimate',
    'deleteEstimate',
    'Delete proforma',
    'Permanently delete a proforma. IRREVERSIBLE. Prefer smartbill_cancel_estimate when a record of the document should survive.',
    'DELETE',
    '/estimate',
    { destructiveHint: true },
  ),
];
