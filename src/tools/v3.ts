import * as z from 'zod';
import { paginationSchema } from '../schemas.ts';
import { cifArg, withCif, type ToolDef } from './shared.ts';

const PAGINATION_NOTE =
  'Cursor pagination: limit is 1-100 (default 20); `after` and `before` are ids and are mutually exclusive. ' +
  'pagination.next is a complete URL that already carries the filters — when it is null the listing is finished, even if the last page filled exactly to limit. ' +
  'No tool can fetch that URL directly: to get the next page yourself, call this tool again passing the last item\'s `id` as `after`.';

type Resource = {
  /** Path segment and English plural used in names and text. */
  plural: string;
  /** Human-readable singular. */
  singular: string;
  listOperationId: string;
  getOperationId: string;
  /** Stable id prefix, e.g. cus_. */
  idPrefix: string;
  /** Extra query filters this listing accepts, beyond pagination. */
  filters: Record<string, z.ZodType>;
  listDescription: string;
  getDescription: string;
};

const nameFilter = z.string().optional().describe('Filter by name.');
const codeFilter = z.string().optional().describe('Filter by internal code.');
const vatCodeFilter = z.string().optional().describe('Filter by VAT code (CIF).');

const RESOURCES: Resource[] = [
  {
    plural: 'clients',
    singular: 'client',
    listOperationId: 'listClientsV3',
    getOperationId: 'getClientV3',
    idPrefix: 'cus_',
    filters: { name: nameFilter, code: codeFilter, vatCode: vatCodeFilter },
    listDescription: 'List clients from the SmartBill client database.',
    getDescription: 'Fetch one client by id, including its delivery addresses.',
  },
  {
    plural: 'suppliers',
    singular: 'supplier',
    listOperationId: 'listSuppliersV3',
    getOperationId: 'getSupplierV3',
    idPrefix: 'sup_',
    filters: { name: nameFilter, code: codeFilter, vatCode: vatCodeFilter },
    listDescription: 'List suppliers from the SmartBill supplier database.',
    getDescription: 'Fetch one supplier by id.',
  },
  {
    plural: 'products',
    singular: 'product',
    listOperationId: 'listProductsV3',
    getOperationId: 'getProductV3',
    idPrefix: 'prod_',
    filters: { name: nameFilter, code: codeFilter },
    listDescription:
      'List products and services from the SmartBill catalogue, with prices, VAT rates and units of measure.',
    getDescription: 'Fetch one product or service by id.',
  },
  {
    plural: 'warehouses',
    singular: 'warehouse',
    listOperationId: 'listWarehousesV3',
    getOperationId: 'getWarehouseV3',
    idPrefix: 'ware_',
    filters: { name: nameFilter },
    listDescription: 'List warehouses (gestiuni) configured in the account.',
    getDescription: 'Fetch one warehouse by id.',
  },
];

function listTool(resource: Resource): ToolDef {
  return {
    name: `smartbill_v3_list_${resource.plural}`,
    operationId: resource.listOperationId,
    api: 'v3',
    title: `List ${resource.plural} (V3)`,
    description: `${resource.listDescription} Ids are prefixed \`${resource.idPrefix}\` and are stable — save them and reuse them later. ${PAGINATION_NOTE}`,
    inputSchema: z.object({
      cif: cifArg,
      ...resource.filters,
      ...paginationSchema.shape,
    }),
    annotations: { readOnlyHint: true },
    run: withCif(async ({ client }, args, cif) => {
      if (args.after !== undefined && args.before !== undefined) {
        return {
          ok: false,
          error: {
            message: '`after` and `before` cannot be used together.',
            code: 'invalid_field_value',
            httpStatus: 0,
            hint: 'Pass one cursor direction only.',
          },
        };
      }
      const query: Record<string, string | number | undefined> = {
        limit: args.limit as number | undefined,
        after: args.after as string | undefined,
        before: args.before as string | undefined,
      };
      for (const key of Object.keys(resource.filters)) {
        query[key] = args[key] as string | undefined;
      }
      return client.request({
        api: 'v3',
        method: 'GET',
        path: `/v3/companies/${encodeURIComponent(cif)}/${resource.plural}`,
        query,
      });
    }),
  };
}

function getTool(resource: Resource): ToolDef {
  return {
    name: `smartbill_v3_get_${resource.singular}`,
    operationId: resource.getOperationId,
    api: 'v3',
    title: `Get ${resource.singular} (V3)`,
    description: `${resource.getDescription} The id must start with \`${resource.idPrefix}\` — an id with any other prefix is rejected as malformed_id before any API call is made.`,
    inputSchema: z.object({
      cif: cifArg,
      id: z.string().describe(`Resource id, starting with ${resource.idPrefix}.`),
    }),
    annotations: { readOnlyHint: true },
    run: withCif(async ({ client }, args, cif) => {
      const id = args.id as string;
      // A prefix mismatch — including a path-traversal attempt like ".." or "." — would otherwise
      // reach `new URL()` and normalise onto some other, wrong endpoint instead of failing loudly.
      // The spec documents this exact rejection for a wrong-prefix id, so reproduce it locally.
      if (!id.startsWith(resource.idPrefix)) {
        return {
          ok: false,
          error: {
            message: `ID must start with ${resource.idPrefix}`,
            code: 'malformed_id',
            httpStatus: 0,
            hint: `Pass a ${resource.singular} id as returned by smartbill_v3_list_${resource.plural} (it starts with ${resource.idPrefix}).`,
          },
        };
      }
      return client.request({
        api: 'v3',
        method: 'GET',
        path: `/v3/companies/${encodeURIComponent(cif)}/${resource.plural}/${encodeURIComponent(id)}`,
      });
    }),
  };
}

export const v3Tools: ToolDef[] = RESOURCES.flatMap((r) => [listTool(r), getTool(r)]);
