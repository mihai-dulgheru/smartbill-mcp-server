import * as z from 'zod';
import { sendEmailRequestSchema } from '../schemas.ts';
import { cifArg, withCif, type ToolDef } from './shared.ts';

export const companyTools: ToolDef[] = [
  {
    name: 'smartbill_get_tax_and_series',
    operationId: 'getTaxAndSeries',
    api: 'v1',
    title: 'Get VAT rates',
    description:
      'List the VAT rates configured in the SmartBill account, with their names and percentages. ' +
      'Call this before creating a document to get the exact `taxName` and `taxPercentage` values the account accepts — inventing them causes the document to be rejected.',
    inputSchema: z.object({ cif: cifArg }),
    annotations: { readOnlyHint: true },
    run: withCif(async ({ client }, _args, cif) => {
      return client.request({ api: 'v1', method: 'GET', path: '/tax', query: { cif } });
    }),
  },
  {
    name: 'smartbill_get_series',
    operationId: 'getSeries',
    api: 'v1',
    title: 'Get document series',
    description:
      'List the document series configured in the SmartBill account, with the next number for each. ' +
      'Call this before creating a document to get the exact `seriesName` the account accepts. ' +
      'Filter with type: "f" invoices, "p" proformas, "c" receipts. Omit type for all series.',
    inputSchema: z.object({
      cif: cifArg,
      type: z
        .enum(['f', 'p', 'c'])
        .optional()
        .describe('f = invoice, p = proforma, c = receipt. Omit for all series.'),
    }),
    annotations: { readOnlyHint: true },
    run: withCif(async ({ client }, args, cif) => {
      return client.request({
        api: 'v1',
        method: 'GET',
        path: '/series',
        query: { cif, type: args.type as string | undefined },
      });
    }),
  },
  {
    name: 'smartbill_get_stocks',
    operationId: 'getStocks',
    api: 'v1',
    title: 'Get stock levels',
    description:
      'Query stock levels at a given date. `date` is required and must be yyyy-MM-dd. ' +
      'warehouseName is CASE-SENSITIVE and must match the warehouse name exactly. ' +
      'Omit the optional filters to get everything.',
    inputSchema: z.object({
      cif: cifArg,
      date: z.string().describe('Stock date, yyyy-MM-dd. Required.'),
      warehouseName: z.string().optional().describe('Warehouse name. CASE-SENSITIVE.'),
      productName: z.string().optional(),
      productCode: z.string().optional().describe('Product SKU.'),
    }),
    annotations: { readOnlyHint: true },
    run: withCif(async ({ client }, args, cif) => {
      return client.request({
        api: 'v1',
        method: 'GET',
        path: '/stocks',
        query: {
          cif,
          date: args.date as string,
          warehouseName: args.warehouseName as string | undefined,
          productName: args.productName as string | undefined,
          productCode: args.productCode as string | undefined,
        },
      });
    }),
  },
  {
    name: 'smartbill_send_document_email',
    operationId: 'sendDocumentEmail',
    api: 'v1',
    title: 'Email a document to a client',
    description:
      'Email an existing invoice or proforma to a client. Omit `to` to use the email address on the client record. ' +
      'type must be "factura" or "proforma". `subject` and `bodyText`, when supplied, must be Base64-encoded — sending raw text wastes the call.',
    inputSchema: z.object({ cif: cifArg, document: sendEmailRequestSchema }),
    run: withCif(async ({ client }, args, cif) => {
      const document = args.document as Record<string, unknown>;
      // companyVatCode last: see smartbill_create_invoice for why.
      return client.request({
        api: 'v1',
        method: 'POST',
        path: '/document/send',
        body: { ...document, companyVatCode: cif },
      });
    }),
  },
];
