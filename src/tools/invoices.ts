import * as z from 'zod';
import { documentRefSchema, invoiceRequestSchema } from '../schemas.ts';
import { cifArg, resolveCif, savePdf, type ToolDef } from './shared.ts';

const docRef = { cif: cifArg, ...documentRefSchema.shape };

const ACCOUNT_STRINGS =
  'seriesName, taxName and measuringUnitName must match values configured in the SmartBill account exactly — read them from smartbill_get_series and smartbill_get_tax_and_series rather than guessing.';

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
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      const invoice = args.invoice as Record<string, unknown>;
      return client.request({
        api: 'v1',
        method: 'POST',
        path: '/invoice/v2',
        body: { companyVatCode: cif, ...invoice },
      });
    },
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
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      return client.request({
        api: 'v1',
        method: 'POST',
        path: '/invoice/reverse',
        body: {
          companyVatCode: cif,
          seriesName: args.seriesName,
          number: args.number,
          issueDate: args.issueDate,
        },
      });
    },
  },
  {
    name: 'smartbill_get_invoice_pdf',
    operationId: 'getInvoicePdf',
    api: 'v1',
    title: 'Download invoice PDF',
    description:
      'Download an invoice as PDF. The file is written to the server download directory and the tool returns its path and size — the PDF bytes are never inlined.',
    inputSchema: z.object(docRef),
    annotations: { readOnlyHint: true },
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      const res = await client.request({
        api: 'v1',
        method: 'GET',
        path: '/invoice/pdf',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
        binary: true,
      });
      if (!res.ok) return res;
      if (!res.bytes) {
        return { ok: false, error: { message: 'SmartBill returned no PDF content.', httpStatus: res.status } };
      }
      const saved = await savePdf(
        config.downloadDir,
        `${args.seriesname}-${args.number}.pdf`,
        res.bytes,
      );
      return { ok: true, data: saved };
    },
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
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      return client.request({
        api: 'v1',
        method: 'GET',
        path: '/invoice/paymentstatus',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
      });
    },
  },
  {
    name: 'smartbill_cancel_invoice',
    operationId: 'cancelInvoice',
    api: 'v1',
    title: 'Cancel invoice',
    description:
      'Mark an invoice as cancelled. Reversible with smartbill_restore_invoice — this does not delete the document.',
    inputSchema: z.object(docRef),
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      return client.request({
        api: 'v1',
        method: 'PUT',
        path: '/invoice/cancel',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
      });
    },
  },
  {
    name: 'smartbill_restore_invoice',
    operationId: 'restoreInvoice',
    api: 'v1',
    title: 'Restore cancelled invoice',
    description: 'Undo smartbill_cancel_invoice, returning the invoice to its active state.',
    inputSchema: z.object(docRef),
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      return client.request({
        api: 'v1',
        method: 'PUT',
        path: '/invoice/restore',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
      });
    },
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
    run: async ({ client, config }, args) => {
      const cif = resolveCif(config, args.cif as string | undefined);
      if (typeof cif !== 'string') return { ok: false, error: cif };
      return client.request({
        api: 'v1',
        method: 'DELETE',
        path: '/invoice',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
      });
    },
  },
];
