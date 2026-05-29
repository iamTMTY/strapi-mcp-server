'use strict';

/**
 * Client-side application of Strapi's URL-driven list query (`_q` search +
 * `filters.$and` clauses produced by the native `SearchInput` and `Filters`
 * components). Our admin pages load all rows up front (audit capped at 200,
 * clients typically few), so we filter in-memory rather than round-tripping.
 */

type FilterClause = Record<string, Record<string, string>>;

export interface McpListQuery {
  _q?: string;
  filters?: { $and?: FilterClause[] };
  /** Strapi's Pagination component writes these to the URL as strings. */
  page?: string | number;
  pageSize?: string | number;
}

export const DEFAULT_PAGE_SIZE = 10;

/**
 * Slice an array to the page selected in the URL query. Pairs with Strapi's
 * native `Pagination` component, which reads/writes `page` + `pageSize` URL
 * params on the same query state our filters and search already use. Returns
 * the visible slice plus pageCount/total for `Pagination.Root`.
 */
export function paginate<T>(
  rows: T[],
  query: McpListQuery
): { rows: T[]; pageCount: number; total: number; page: number; pageSize: number } {
  const pageSize = Math.max(1, Number(query.pageSize) || DEFAULT_PAGE_SIZE);
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pageCount, Math.max(1, Number(query.page) || 1));
  const start = (page - 1) * pageSize;
  return { rows: rows.slice(start, start + pageSize), pageCount, total, page, pageSize };
}

/**
 * Day-granular comparison for $gt/$gte/$lt/$lte and date-aware $eq/$ne. We
 * compare only the `YYYY-MM-DD` prefix of each value, so a `date` filter
 * ("May 27") matches a row stored at any time on that day. ISO date prefixes
 * sort lexicographically, so a string compare is correct and timezone-stable.
 * Returns `negative | 0 | positive`, or null when either side isn't a date
 * (so enum filters fall back to exact string matching).
 */
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})/;

function datePart(value: string): string | null {
  const m = DATE_PREFIX_RE.exec(value);
  return m ? m[1] : null;
}

function dateCompare(a: string, b: string): number | null {
  const ap = datePart(a);
  const bp = datePart(b);
  if (ap === null || bp === null) return null;
  return ap < bp ? -1 : ap > bp ? 1 : 0;
}

function ordCompare(a: string, b: string): number {
  const d = dateCompare(a, b);
  if (d !== null) return d;
  const an = Number(a);
  const bn = Number(b);
  if (a !== '' && b !== '' && !Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
  return a < b ? -1 : a > b ? 1 : 0;
}

function matchOp(rowValue: string | null | undefined, op: string, value: string): boolean {
  const rv = rowValue ?? '';
  const rvl = rv.toLowerCase();
  const vl = (value ?? '').toLowerCase();
  switch (op) {
    case '$eq': {
      const d = dateCompare(rv, value);
      return d !== null ? d === 0 : rv === value;
    }
    case '$eqi':
      return rvl === vl;
    case '$ne': {
      const d = dateCompare(rv, value);
      return d !== null ? d !== 0 : rv !== value;
    }
    case '$nei':
      return rvl !== vl;
    case '$null':
      return rv === '';
    case '$notNull':
      return rv !== '';
    case '$gt':
      return rv !== '' && ordCompare(rv, value) > 0;
    case '$gte':
      return rv !== '' && ordCompare(rv, value) >= 0;
    case '$lt':
      return rv !== '' && ordCompare(rv, value) < 0;
    case '$lte':
      return rv !== '' && ordCompare(rv, value) <= 0;
    case '$contains':
      return rv.includes(value);
    case '$containsi':
      return rvl.includes(vl);
    case '$notContains':
      return !rv.includes(value);
    case '$notContainsi':
      return !rvl.includes(vl);
    case '$startsWith':
      return rv.startsWith(value);
    case '$endsWith':
      return rv.endsWith(value);
    default:
      // Unknown operator → don't exclude the row.
      return true;
  }
}

export function applyMcpQuery<T>(
  rows: T[],
  query: McpListQuery,
  opts: {
    /** Concatenated searchable text for the `_q` free-text match. */
    searchText: (row: T) => string;
    /** Resolve a filter field name to the row's comparable string value. */
    field: (row: T, name: string) => string | null | undefined;
  }
): T[] {
  let result = rows;

  const q = (query._q ?? '').trim().toLowerCase();
  if (q) {
    result = result.filter((r) => opts.searchText(r).toLowerCase().includes(q));
  }

  const and = query.filters?.$and ?? [];
  for (const clause of and) {
    const entries = Object.entries(clause);
    if (entries.length === 0) continue;
    const [fieldName, opObj] = entries[0];
    const opEntries = Object.entries(opObj ?? {});
    if (opEntries.length === 0) continue;
    const [op, value] = opEntries[0];
    result = result.filter((r) => matchOp(opts.field(r, fieldName), op, String(value)));
  }

  return result;
}

/** True when the query carries any active search text or filter clause. */
export function hasActiveQuery(query: McpListQuery): boolean {
  return Boolean((query._q ?? '').trim()) || (query.filters?.$and?.length ?? 0) > 0;
}
