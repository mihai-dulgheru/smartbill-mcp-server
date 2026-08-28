import * as z from 'zod';
import { deletablePaymentTypeEnum, documentRefSchema, paymentRequestSchema } from '../schemas.ts';
import { cifArg, withCif, withStatusHint, type ToolDef } from './shared.ts';

export const paymentTools: ToolDef[] = [
  {
    name: 'smartbill_create_payment',
    operationId: 'createPayment',
    api: 'v1',
    title: 'Record a payment',
    description:
      'Record a payment (incasare) against one or more invoices, or as a standalone receipt. ' +
      'Set useInvoiceDetails with invoicesList to take the client and products from existing invoices instead of restating them. ' +
      'When type is "Chitanta", seriesName must be a receipt series configured in the account (type "c" in smartbill_get_series).',
    inputSchema: z.object({ cif: cifArg, payment: paymentRequestSchema }),
    annotations: { destructiveHint: false, idempotentHint: false },
    run: withCif(async ({ client }, args, cif) => {
      const payment = args.payment as Record<string, unknown>;
      // companyVatCode last: see smartbill_create_invoice for why.
      return client.request({
        api: 'v1',
        method: 'POST',
        path: '/payment',
        body: { ...payment, companyVatCode: cif },
      });
    }),
  },
  {
    name: 'smartbill_get_payment_receipt_text',
    operationId: 'getPaymentText',
    api: 'v1',
    title: 'Get fiscal receipt text',
    description:
      'Fetch the fiscal-printer text for a receipt by its document id. The content arrives Base64-encoded in the `message` field of the response. ' +
      'This endpoint returns no JSON error for a bad id: a 500 with an HTML body means `id` is invalid or does not belong to an existing fiscal receipt.',
    inputSchema: z.object({
      cif: cifArg,
      id: z
        .number()
        .int()
        .describe('Document id of the receipt, as returned by smartbill_create_payment.'),
    }),
    annotations: { readOnlyHint: true },
    run: withCif(async ({ client }, args, cif) => {
      return withStatusHint(
        await client.request({
          api: 'v1',
          method: 'GET',
          path: '/payment/text',
          query: { cif, id: args.id as number },
        }),
        500,
        'This endpoint returns no JSON error: a 500 means `id` is invalid or does not belong to an existing fiscal receipt. Verify it rather than retrying.',
      );
    }),
  },
  {
    name: 'smartbill_delete_receipt',
    operationId: 'deleteReceipt',
    api: 'v1',
    title: 'Delete receipt (chitanta)',
    description:
      'Permanently delete a receipt by its series and number. IRREVERSIBLE. Only the most recent receipt in a series can normally be deleted. ' +
      'This is the only way to remove a Chitanta - smartbill_delete_payment does not accept that type.',
    inputSchema: z.object({ cif: cifArg, ...documentRefSchema.shape }),
    annotations: { destructiveHint: true },
    run: withCif(async ({ client }, args, cif) => {
      return client.request({
        api: 'v1',
        method: 'DELETE',
        path: '/payment/chitanta',
        query: { cif, seriesname: args.seriesname as string, number: args.number as string },
      });
    }),
  },
  {
    name: 'smartbill_delete_payment',
    operationId: 'deletePaymentV2',
    api: 'v1',
    title: 'Delete a non-receipt payment',
    description:
      'Permanently delete a payment. IRREVERSIBLE. Identify it either by invoice (invoiceSeries + invoiceNumber) or by payment details (paymentDate, paymentValue, clientName, clientCif). ' +
      'paymentType must match the type actually recorded on the payment; a mismatch returns "Nu au fost gasite incasari conform datelor specificate." ' +
      'Chitanta and Bon fiscal cannot be deleted here - use smartbill_delete_receipt for a Chitanta.',
    inputSchema: z.object({
      cif: cifArg,
      paymentType: deletablePaymentTypeEnum.describe(
        'The type recorded on the payment being deleted.',
      ),
      invoiceSeries: z.string().optional(),
      invoiceNumber: z.string().optional(),
      paymentDate: z.string().optional().describe('yyyy-MM-dd.'),
      paymentValue: z.number().optional(),
      clientName: z.string().optional(),
      clientCif: z.string().optional(),
    }),
    annotations: { destructiveHint: true },
    run: withCif(async ({ client }, args, cif) => {
      return client.request({
        api: 'v1',
        method: 'DELETE',
        path: '/payment/v2',
        query: {
          cif,
          paymentType: args.paymentType as string,
          invoiceSeries: args.invoiceSeries as string | undefined,
          invoiceNumber: args.invoiceNumber as string | undefined,
          paymentDate: args.paymentDate as string | undefined,
          paymentValue: args.paymentValue as number | undefined,
          clientName: args.clientName as string | undefined,
          clientCif: args.clientCif as string | undefined,
        },
      });
    }),
  },
];
