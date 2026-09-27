/**
 * Tenancy is a Postgres schema: each tenant's graph lives in `tenant_<slug>`.
 *
 * Every graph query in this app names its schema through `tbl()` — the single
 * place a schema identifier is turned into SQL. Postgres cannot take an
 * identifier as a bind parameter, so this is also the single place that has to
 * be right about validation: the name must match the pattern the control plane
 * enforces with a CHECK constraint, and the table must be one of the five
 * graph tables. Anything else throws before any SQL is built.
 */

export type Tenant = {
  id: number;
  slug: string;
  schema: string;
  displayName: string;
};

const SCHEMA_RE = /^tenant_[a-z0-9_]{1,40}$/;
const GRAPH_TABLES = new Set(["repos", "nodes", "edges", "files", "imports"]);

export function assertSchema(schema: string): string {
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`invalid tenant schema "${schema}"`);
  }
  return schema;
}

/** A fully-qualified, quoted graph table reference, e.g. "tenant_owner"."nodes". */
export function tbl(schema: string, table: string): string {
  if (!GRAPH_TABLES.has(table)) throw new Error(`not a graph table: "${table}"`);
  return `"${assertSchema(schema)}"."${table}"`;
}
