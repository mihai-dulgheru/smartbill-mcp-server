import * as z from 'zod';

export const currencyEnum = z.enum([
  'RON', 'EUR', 'USD', 'GBP', 'CAD', 'AUD', 'CHF', 'TRY', 'CZK', 'DKK', 'HUF',
  'MDL', 'SEK', 'NOK', 'JPY', 'EGP', 'PLN', 'RUB', 'AED', 'BRL', 'CNY', 'HRK',
  'INR', 'KRW', 'MXN', 'NZD', 'RSD', 'THB', 'UAH', 'XDR', 'ZAR',
]);

export const languageEnum = z.enum(['RO', 'EN', 'DE', 'FR', 'IT', 'ES']);

/** Accepted by POST /payment. */
export const paymentTypeEnum = z.enum([
  'Card', 'Card online', 'Chitanta', 'Bon', 'Ordin plata', 'CEC', 'Bilet ordin',
  'Mandat postal', 'Extras de cont', 'Ramburs', 'Alta incasare',
]);

/** Accepted inside an invoice's `payment` object. */
export const invoicePaymentTypeEnum = z.enum([
  'Chitanta', 'Bon', 'Card', 'Card online', 'CEC', 'Bilet ordin', 'Ordin plata',
  'Mandat postal', 'Extras de cont', 'Ramburs', 'Alta incasare',
]);

/** Accepted by DELETE /payment/v2 — excludes Chitanta and Bon fiscal by design. */
export const deletablePaymentTypeEnum = z.enum([
  'Card', 'Card online', 'CEC', 'Bilet ordin', 'Ordin plata', 'Mandat postal',
  'Extras de cont', 'Ramburs', 'Alta incasare',
]);

export const clientSchema = z.object({
  name: z.string().describe('Client name. Required.'),
  country: z.string().describe('Country, e.g. "Romania". Required.'),
  vatCode: z.string().optional().describe('Client CIF/VAT code.'),
  isTaxPayer: z.boolean().optional().describe('True if the client is VAT-registered.'),
  regCom: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  county: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  contact: z.string().optional(),
  iban: z.string().optional(),
  bank: z.string().optional(),
  code: z.string().optional().describe('Your internal client code.'),
  saveToDb: z.boolean().optional().describe('Save this client to the SmartBill client list.'),
});

export const productSchema = z.object({
  name: z.string().describe('Product name. Required.'),
  quantity: z.number().describe('Quantity. Required.'),
  price: z.number().min(0).describe(
    'Unit price. EXCLUDES VAT unless isTaxIncluded is true — this is the most common source of wrong totals.',
  ),
  measuringUnitName: z.string().describe(
    'Unit of measure, e.g. "buc". Must match a unit configured in the SmartBill account exactly — read it from smartbill_get_tax_and_series.',
  ),
  taxPercentage: z.number().describe('VAT percentage as a bare number, e.g. 21. Never "21%".'),
  code: z.string().optional().describe('SKU. Required if your company has the "Foloseste cod produs" setting enabled in SmartBill Cloud, otherwise optional.'),
  productDescription: z.string().optional(),
  isService: z.boolean().optional(),
  currency: currencyEnum.optional(),
  exchangeRate: z.number().optional(),
  isTaxIncluded: z.boolean().optional().describe('Defaults to false: price is treated as ex-VAT.'),
  taxName: z.string().optional().describe(
    'VAT rate name, e.g. "Normala". Must match a rate configured in the account — read it from smartbill_get_tax_and_series.',
  ),
  warehouseName: z.string().optional().describe('Warehouse name. Case-sensitive.'),
  isDiscount: z.boolean().optional(),
  numberOfItems: z.number().int().optional().describe('How many preceding lines the discount applies to.'),
  discountType: z.union([z.literal(1), z.literal(2)]).optional().describe('Discount type: 1 = value-based (paired with discountValue, which must be negative); 2 = percentage (paired with discountPercentage). Defaults to 2 when omitted on a discount line. Sending any other value is not rejected but produces a wrong document.'),
  discountValue: z.number().lt(0).optional().describe('Value-based discount amount when discountType is 1. Must be strictly negative (e.g. -10 for a 10 RON discount). A positive value is not rejected by the API but will increase the total instead of reducing it.'),
  discountPercentage: z.number().gt(0).lte(100).optional().describe('Percentage discount when discountType is 2. Must be between 0 (exclusive) and 100 (inclusive). Sent as a bare number (e.g. 10, never "10%").'),
  translatedName: z.string().optional(),
  translatedMeasuringUnit: z.string().optional(),
  saveToDb: z.boolean().optional(),
  useSBProductName: z.boolean().optional(),
});

export const invoicePaymentSchema = z.object({
  value: z.number().optional(),
  paymentSeries: z.string().optional().describe('Receipt series, required when type is "Chitanta".'),
  type: invoicePaymentTypeEnum.optional(),
  isCash: z.boolean().optional(),
});

export const emailRecipientsSchema = z.object({
  to: z.string().optional(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
});

/** Fields shared by POST /invoice/v2 and POST /estimate/v2. */
const documentBase = {
  seriesName: z.string().describe(
    'Document series name. Must match a series configured in the SmartBill account — read it from smartbill_get_series. Do not invent one.',
  ),
  client: clientSchema,
  products: z.array(productSchema).min(1),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('yyyy-MM-dd. Defaults to today.'),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('yyyy-MM-dd.'),
  isDraft: z.boolean().optional(),
  currency: currencyEnum.optional(),
  exchangeRate: z.number().optional(),
  precision: z.number().int().optional(),
  paymentUrl: z.string().optional().describe('Set to "Generate URL" to get a payment link in the response `url` field.'),
  sendEmail: z.boolean().optional(),
  email: emailRecipientsSchema.optional(),
  observations: z.string().optional(),
  mentions: z.string().optional(),
  issuerName: z.string().optional(),
  issuerCnp: z.string().optional(),
  delegateName: z.string().optional(),
  delegateIdentityCard: z.string().optional(),
  delegateAuto: z.string().optional(),
  useIntraCif: z.boolean().optional(),
  aviz: z.string().optional(),
};

export const invoiceRequestSchema = z.object({
  ...documentBase,
  language: languageEnum.optional(),
  useStock: z.boolean().optional().describe('Discharge stock. Every product then needs a `code`.'),
  payment: invoicePaymentSchema.optional(),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  usePaymentTax: z.boolean().optional().describe('VAT on collection (TVA la incasare).'),
  paymentBase: z.number().optional(),
  colectedTax: z.number().optional(),
  paymentTotal: z.number().optional(),
  useEstimateDetails: z.boolean().optional().describe('Copy the products from a proforma named in `estimate`.'),
  estimate: z
    .object({
      seriesName: z.string(),
      number: z.string(),
      useStock: z.boolean().optional().describe('Discharge stock when issuing the invoice generated from the proforma.'),
    })
    .optional()
    .describe('The proforma to invoice, when useEstimateDetails is true.'),
});

export const estimateRequestSchema = z.object({
  ...documentBase,
  language: z.string().optional(),
});

export const paymentRequestSchema = z.object({
  type: paymentTypeEnum,
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('yyyy-MM-dd.'),
  isDraft: z.boolean().optional(),
  seriesName: z.string().optional().describe('Receipt series, required when type is "Chitanta".'),
  number: z.string().optional(),
  returnFiscalPrinterText: z.boolean().optional(),
  observation: z.string().optional(),
  useStock: z.boolean().optional(),
  client: clientSchema.optional(),
  products: z.array(productSchema).optional(),
  value: z.number().optional(),
  currency: z.string().optional().describe('Payment currency. Defaults to RON. Fiscal receipts (bon fiscal) can only be issued in RON.'),
  exchangeRate: z.number().optional(),
  precision: z.number().int().optional(),
  isCash: z.boolean().optional(),
  receivedCash: z.number().optional(),
  receivedCard: z.number().optional(),
  receivedTicheteMasa: z.number().optional(),
  receivedTicheteCadou: z.number().optional(),
  receivedOrdinDePlata: z.number().optional(),
  receivedCec: z.number().optional(),
  receivedCredit: z.number().optional(),
  receivedCupon: z.number().optional(),
  receivedPuncteDeFidelitate: z.number().optional(),
  receivedBonuriValoareFixa: z.number().optional(),
  receivedMonedaAlternativa: z.number().optional(),
  text: z.string().optional(),
  translatedText: z.string().optional(),
  language: z.string().optional(),
  useInvoiceDetails: z.boolean().optional().describe('Take the client and products from the invoices in invoicesList.'),
  invoicesList: z
    .union([
      z.array(z.object({ seriesName: z.string(), number: z.string() })),
      z.object({ seriesName: z.string(), number: z.string() }),
    ])
    .optional()
    .describe('Invoice or list of invoices this payment settles.'),
});

export const sendEmailRequestSchema = z.object({
  seriesName: z.string(),
  number: z.string(),
  type: z.enum(['factura', 'proforma']),
  to: z.string().email().optional().describe('Defaults to the client email on record.'),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().optional().describe('Email subject. Must be Base64-encoded, not raw text.'),
  bodyText: z.string().optional().describe('Email body. Must be Base64-encoded, not raw text.'),
});

/** The series + number pair that identifies a V1 document. */
export const documentRefSchema = z.object({
  seriesname: z.string().describe('Document series name.'),
  number: z.string().describe('Document number.'),
});

/** V3 cursor pagination. */
export const paginationSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().describe('1-100, default 20.'),
  after: z.string().optional().describe('Cursor id to continue after. Mutually exclusive with `before`.'),
  before: z.string().optional().describe('Cursor id to continue before. Mutually exclusive with `after`.'),
});
