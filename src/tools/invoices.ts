import * as z from 'zod';
import { documentRefSchema, invoiceRequestSchema } from '../schemas.ts';
import { cifArg, savePdf, withCif, withStatusHint, type ToolDef } from './shared.ts';

const docRef = { cif: cifArg, ...documentRefSchema.shape };

const ACCOUNT_STRINGS =
  'seriesName, taxName and measuringUnitName must match values configured in the SmartBill account exactly — never guess them. seriesName comes from smartbill_get_series, taxName from smartbill_get_tax_and_series, and measuringUnitName from smartbill_get_stocks or smartbill_v3_list_products, or by asking the user.';

export const invoiceTools: ToolDef[] = [
  {
    name: 'smartbill_create_invoice',
    operationId: 'createInvoiceV2',
    api: 'v1',
    title: 'Create invoice',
    description:
      'Issue a new invoice in SmartBill Cloud. ' +
      ACCOUNT_STRINGS +
      ' Product prices EXCLUDE VAT unless isTaxIncluded is true. taxPercentage is a bare number (21), never a string ("21%"). ' +
      'On success the response carries `number`, `series`, `documentId` and `documentViewUrl` — the last is a public PDF link safe to send to the client.',
    inputSchema: z.object({ cif: cifArg, invoice: invoiceRequestSchema }),
    annotations: { destructiveHint: false, idempotentHint: false },
    run: withCif(async ({ client }, args, cif) => {
      const invoice = args.invoice as Record<string, unknown>;
      // companyVatCode last: unconditional override of any (impossible, but future-proof) same-named
      // key in the spread, rather than depending on the schema having stripped it first.
      return client.request({
        api: 'v1',
        method: 'POST',
        path: '/invoice/v2',
        body: { ...invoice, companyVatCode: cif },
      });
    }),
  },
  {
    name: 'smartbill_create_storno_invoice',
    operationId: 'createStornoInvoice',
    api: 'v1',
    title: 'Create storno (reversal) invoice',
    description:
      'Issue a storno invoice that reverses an existing invoice. Identify the original by its series and number. ' +
      'Use this rather than deleting when the original has already been sent to the client or reported.',
    inputSchema: z.object({
      cif: cifArg,
      seriesName: z.string().describe('Series of the ORIGINAL invoice.'),
      number: z.string().describe('Number of the ORIGINAL invoice.'),
      issueDate: z.string().optional().describe('yyyy-MM-dd. Defaults to today.'),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
    run: withCif(async ({ client }, args, cif) => {
      return client.request({
        api: 'v1',
        method: 'POST',
        path: '/invoice/reverse',
        body: {
          seriesName: args.seriesName,
          number: args.number,
          issueDate: args.issueDate,
          companyVatCode: cif,
        },
      });
    }),
  },
  {
    name: 'smartbill_get_invoice_pdf',
    operationId: 'getInvoicePdf',
    api: 'v1',
    title: 'Download invoice PDF',
    description:
      'Download an invoice as PDF. The file is written to the server download directory and the tool returns its path and size — the PDF bytes are never inlined. ' +
      'This endpoint returns no JSON error: any missing parameter or nonexistent invoice comes back as a 502 with an HTML body — a 502 here means check `seriesname`, `number` and that the invoice exists, not a proxy fluke worth retrying.',
    inputSchema: z.object(docRef),
    annotations: { readOnlyHint: true },
    run: withCif(async ({ client, config }, args, cif) => {
      const res = withStatusHint(
        await client.request({
          api: 'v1',
          method: 'GET',
          path: '/invoice/pdf',
          query: { cif, seriesname: args.seriesname as string, number: args.number as string },
          binary: true,
        }),
        502,
        'This endpoint returns no JSON error: a 502 means `seriesname` or `number` is missing, or the invoice does not exist. Verify those rather than retrying.',
      );
      if (!res.ok) return res;
      // A defined-but-empty body is just as unusable as a missing one — treat it the same way
      // rather than silently saving a 0-byte "PDF".
      if (!res.bytes || res.bytes.length === 0) {
        return {
          ok: false,
          error: { message: 'SmartBill returned no PDF content.', httpStatus: res.status },
        };
      }
      const saved = await savePdf(
        config.downloadDir,
        `${cif}-${String(args.seriesname)}-${String(args.number)}.pdf`,
        res.bytes,
      );
      return { ok: true, data: saved };
    }),
  },
  {
    name: 'smartbill_get_invoice_payment_status',
    operationId: 'getInvoicePaymentStatus',
    api: 'v1',
    title: 'Get invoice payment status',
    description:
      'Check how much of an invoice has been paid. Returns invoiceTotalAmount, paidAmount, unpaidAmount and a `paid` flag.',
    inputSchema: z.object(docRef),
    annotations: { readOnlyHint: true },
    run: withCif(async ({ client }, args, cif) => {
      return client.request({
        api: 'v1',
        method: 'GET',
        path: '/invoice/paymentstatus',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
      });
    }),
  },
  {
    name: 'smartbill_cancel_invoice',
    operationId: 'cancelInvoice',
    api: 'v1',
    title: 'Cancel invoice',
    description:
      'Mark an invoice as cancelled. Reversible with smartbill_restore_invoice — this does not delete the document. ' +
      'Idempotent: cancelling an invoice that is already cancelled still succeeds, carrying an informational message rather than failing as a tool error.',
    inputSchema: z.object(docRef),
    annotations: { destructiveHint: false, idempotentHint: true },
    run: withCif(async ({ client }, args, cif) => {
      return client.request({
        api: 'v1',
        method: 'PUT',
        path: '/invoice/cancel',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
      });
    }),
  },
  {
    name: 'smartbill_restore_invoice',
    operationId: 'restoreInvoice',
    api: 'v1',
    title: 'Restore cancelled invoice',
    description:
      'Undo smartbill_cancel_invoice, returning the invoice to its active state. ' +
      'Idempotent: restoring an invoice that was never cancelled still succeeds, carrying an informational message rather than failing as a tool error.',
    inputSchema: z.object(docRef),
    annotations: { destructiveHint: false, idempotentHint: true },
    run: withCif(async ({ client }, args, cif) => {
      return client.request({
        api: 'v1',
        method: 'PUT',
        path: '/invoice/restore',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
      });
    }),
  },
  {
    name: 'smartbill_delete_invoice',
    operationId: 'deleteInvoice',
    api: 'v1',
    title: 'Delete invoice',
    description:
      'Permanently delete an invoice. IRREVERSIBLE. Only the most recent invoice in a series can normally be deleted. ' +
      'For an invoice already sent or reported, issue a storno with smartbill_create_storno_invoice instead.',
    inputSchema: z.object(docRef),
    annotations: { destructiveHint: true },
    run: withCif(async ({ client }, args, cif) => {
      return client.request({
        api: 'v1',
        method: 'DELETE',
        path: '/invoice',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
      });
    }),
  },
];
