import "server-only";

import { getProductionHardeningPolicy } from "@/lib/config/production-hardening";

export interface PageRequest {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export interface PageEnvelope<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * Parses `page`/`pageSize` query parameters per
 * specs/021-production-hardening-garbage-collection/contracts/pagination-envelope.md:
 * - `page` missing/invalid/`< 1` -> `1`, never an error.
 * - `pageSize` missing/invalid/`<= 0` -> `defaultPageSize`.
 * - `pageSize` is always clamped to the server's `PAGINATION_MAX_PAGE_SIZE`
 *   regardless of what the caller requests -- silently clamped, never rejected.
 *
 * This is a stateless request-parsing helper, not a cache or a data store --
 * it holds no state across calls and every route below still owns its own
 * query/filter. It exists only so the four newly-bounded list routes (T068,
 * T069, T071) parse and clamp `page`/`pageSize` identically instead of each
 * reimplementing the same clamping rules slightly differently.
 */
export function parsePageRequest(searchParams: URLSearchParams, defaultPageSize: number): PageRequest {
  const maxPageSize = getProductionHardeningPolicy().PAGINATION_MAX_PAGE_SIZE;
  const rawPage = Number.parseInt(searchParams.get("page") ?? "", 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const rawPageSize = Number.parseInt(searchParams.get("pageSize") ?? "", 10);
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0
    ? Math.min(rawPageSize, maxPageSize)
    : Math.min(defaultPageSize, maxPageSize);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/** Slices an already-fully-fetched in-memory array into one page envelope. Used by
 * routes whose underlying service returns a full array with no Prisma-level
 * pagination (source connections, AI models) rather than adding new
 * skip/take query plumbing to those services for what are small, per-user
 * or catalog-sized result sets. */
export function paginateInMemory<T>(all: T[], request: PageRequest): PageEnvelope<T> {
  return { items: all.slice(request.skip, request.skip + request.take), page: request.page, pageSize: request.pageSize, total: all.length };
}