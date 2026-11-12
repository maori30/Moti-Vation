/* eslint-disable @typescript-eslint/no-explicit-any */
// Minimal supabase-js compatible query builder that talks to Postgres directly
// over SUPABASE_DB_URL (no REST API, no API keys).
//
// Why: the project's secret API key started failing at the REST gateway with
// "JWT issued at future" (PGRST303), which silently broke every DB call in the
// bot. A direct connection does not depend on API keys at all.
//
// Supported surface (exactly what this codebase uses):
//   from(t).select(cols?, { count: "exact", head?: true })
//          .insert(row|rows) .update(obj) .upsert(row|rows, { onConflict }) .delete()
//          .eq .neq .gt .gte .lt .lte .ilike .is .in .not(col, "is", null)
//          .order(col, { ascending }) .limit(n) .single() .maybeSingle()
//   Result: { data, error, count, status } — never throws, like supabase-js.

import postgres from "npm:postgres@3.4.5";

type Row = Record<string, unknown>;
type DbError = { message: string; code?: string; details?: string | null; hint?: string | null };
type Result = { data: any; error: DbError | null; count: number | null; status: number };

const PG_INT8 = 20;
const PG_NUMERIC = 1700;
const PG_TIMESTAMP = 1114;
const PG_TIMESTAMPTZ = 1184;

function toIso(value: string): string {
  // Postgres text format: "2026-11-12 05:10:58.505972+00" -> ISO 8601
  const normalized = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

let sqlClient: ReturnType<typeof postgres> | null = null;

function sql() {
  if (sqlClient) return sqlClient;
  const url = Deno.env.get("SUPABASE_DB_URL");
  if (!url) throw new Error("SUPABASE_DB_URL is not set");
  sqlClient = postgres(url, {
    prepare: false,
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
    // Match PostgREST JSON shapes: int8/numeric as numbers, timestamps as ISO strings,
    // date stays "YYYY-MM-DD" (postgres.js default for date is a Date, override it too).
    types: {
      int8: { to: PG_INT8, from: [PG_INT8], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
      numeric: { to: PG_NUMERIC, from: [PG_NUMERIC], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
      ts: { to: PG_TIMESTAMPTZ, from: [PG_TIMESTAMP, PG_TIMESTAMPTZ], serialize: (x: unknown) => (x instanceof Date ? x.toISOString() : String(x)), parse: toIso },
      date: { to: 1082, from: [1082], serialize: (x: unknown) => String(x), parse: (x: string) => x },
    },
  } as any);
  return sqlClient;
}

function ident(name: string): string {
  const clean = name.trim();
  if (clean === "*") return "*";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(clean)) throw new Error(`Invalid identifier: ${name}`);
  return `"${clean}"`;
}

function columns(spec?: string): string {
  if (!spec || spec.trim() === "*" || spec.trim() === "") return "*";
  return spec.split(",").map((c) => ident(c)).join(", ");
}

function pgArrayLiteral(values: unknown[]): string {
  const items = values.map((v) => {
    if (v === null || v === undefined) return "NULL";
    const s = String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${s}"`;
  });
  return `{${items.join(",")}}`;
}

// All parameters are sent untyped and coerced by Postgres to the column type.
function serialize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return pgArrayLiteral(value);
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return value;
}

type Filter = { sql: (p: (v: unknown) => string) => string };
type Mode = "select" | "insert" | "update" | "upsert" | "delete";

class Query implements PromiseLike<Result> {
  private mode: Mode = "select";
  private selectCols = "*";
  private returning: string | null = null;
  private countExact = false;
  private headOnly = false;
  private filters: Filter[] = [];
  private orders: string[] = [];
  private limitN: number | null = null;
  private rows: Row[] = [];
  private patch: Row = {};
  private conflict: string[] = [];
  private singleMode: "single" | "maybe" | null = null;

  constructor(private table: string) {}

  select(cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.mode === "select") {
      this.selectCols = columns(cols);
      if (opts?.count === "exact") this.countExact = true;
      if (opts?.head) this.headOnly = true;
    } else {
      this.returning = columns(cols);
    }
    return this;
  }
  insert(values: Row | Row[]) { this.mode = "insert"; this.rows = Array.isArray(values) ? values : [values]; return this; }
  upsert(values: Row | Row[], opts?: { onConflict?: string }) {
    this.mode = "upsert";
    this.rows = Array.isArray(values) ? values : [values];
    this.conflict = (opts?.onConflict ?? "id").split(",").map((c) => c.trim()).filter(Boolean);
    return this;
  }
  update(values: Row) { this.mode = "update"; this.patch = values; return this; }
  delete() { this.mode = "delete"; return this; }

  private op(col: string, operator: string, value: unknown) {
    this.filters.push({ sql: (p) => `${ident(col)} ${operator} ${p(value)}` });
    return this;
  }
  eq(col: string, v: unknown) { return this.op(col, "=", v); }
  neq(col: string, v: unknown) { return this.op(col, "<>", v); }
  gt(col: string, v: unknown) { return this.op(col, ">", v); }
  gte(col: string, v: unknown) { return this.op(col, ">=", v); }
  lt(col: string, v: unknown) { return this.op(col, "<", v); }
  lte(col: string, v: unknown) { return this.op(col, "<=", v); }
  ilike(col: string, v: unknown) { return this.op(col, "ILIKE", v); }
  is(col: string, v: null | boolean) {
    const word = v === null ? "NULL" : v ? "TRUE" : "FALSE";
    this.filters.push({ sql: () => `${ident(col)} IS ${word}` });
    return this;
  }
  not(col: string, operator: string, v: unknown) {
    if (operator === "is") {
      const word = v === null ? "NULL" : v ? "TRUE" : "FALSE";
      this.filters.push({ sql: () => `${ident(col)} IS NOT ${word}` });
    } else if (operator === "eq") {
      this.filters.push({ sql: (p) => `${ident(col)} <> ${p(v)}` });
    } else {
      throw new Error(`not(${operator}) is not supported`);
    }
    return this;
  }
  in(col: string, values: unknown[]) {
    if (!values.length) { this.filters.push({ sql: () => "FALSE" }); return this; }
    this.filters.push({ sql: (p) => `${ident(col)} = ANY(${p(values)})` });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push(`${ident(col)} ${opts?.ascending === false ? "DESC" : "ASC"}`);
    return this;
  }
  limit(n: number) { this.limitN = Math.max(0, Math.floor(n)); return this; }
  single() { this.singleMode = "single"; return this; }
  maybeSingle() { this.singleMode = "maybe"; return this; }

  private build(): { text: string; params: unknown[] } {
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(serialize(v)); return `$${params.length}`; };
    const where = this.filters.length ? ` WHERE ${this.filters.map((f) => f.sql(p)).join(" AND ")}` : "";
    const table = ident(this.table);
    const ret = this.returning ? ` RETURNING ${this.returning}` : "";

    if (this.mode === "select") {
      if (this.headOnly) return { text: `SELECT count(*)::int AS count FROM ${table}${where}`, params };
      const order = this.orders.length ? ` ORDER BY ${this.orders.join(", ")}` : "";
      const lim = this.limitN !== null ? ` LIMIT ${this.limitN}` : this.singleMode ? " LIMIT 2" : "";
      return { text: `SELECT ${this.selectCols} FROM ${table}${where}${order}${lim}`, params };
    }
    if (this.mode === "update") {
      const keys = Object.keys(this.patch).filter((k) => this.patch[k] !== undefined);
      if (!keys.length) throw new Error("update() with no columns");
      const set = keys.map((k) => `${ident(k)} = ${p(this.patch[k])}`).join(", ");
      return { text: `UPDATE ${table} SET ${set}${where}${ret}`, params };
    }
    if (this.mode === "delete") {
      return { text: `DELETE FROM ${table}${where}${ret}`, params };
    }
    // insert / upsert
    if (!this.rows.length) throw new Error(`${this.mode}() with no rows`);
    const keys = [...new Set(this.rows.flatMap((r) => Object.keys(r).filter((k) => r[k] !== undefined)))];
    const values = this.rows
      .map((r) => `(${keys.map((k) => (r[k] === undefined ? "DEFAULT" : p(r[k]))).join(", ")})`)
      .join(", ");
    let text = `INSERT INTO ${table} (${keys.map(ident).join(", ")}) VALUES ${values}`;
    if (this.mode === "upsert") {
      const updatable = keys.filter((k) => !this.conflict.includes(k));
      text += ` ON CONFLICT (${this.conflict.map(ident).join(", ")}) `;
      text += updatable.length
        ? `DO UPDATE SET ${updatable.map((k) => `${ident(k)} = EXCLUDED.${ident(k)}`).join(", ")}`
        : "DO NOTHING";
    }
    return { text: text + ret, params };
  }

  async execute(): Promise<Result> {
    try {
      const { text, params } = this.build();
      const rows = await sql().unsafe(text, params as any[]);
      const list = Array.from(rows as unknown as Row[]);

      if (this.mode === "select" && this.headOnly) {
        return { data: null, error: null, count: Number(list[0]?.count ?? 0), status: 200 };
      }
      const isRead = this.mode === "select" || this.returning !== null;
      if (!isRead) return { data: null, error: null, count: null, status: this.mode === "insert" ? 201 : 204 };

      let count: number | null = null;
      if (this.countExact) {
        const counter = new Query(this.table);
        counter.filters = this.filters;
        counter.headOnly = true;
        count = (await counter.execute()).count;
      }
      if (this.singleMode) {
        if (list.length === 1) return { data: list[0], error: null, count, status: 200 };
        if (list.length === 0 && this.singleMode === "maybe") return { data: null, error: null, count, status: 200 };
        return {
          data: null,
          error: { code: "PGRST116", message: `JSON object requested, multiple (or no) rows returned (${list.length})`, details: null, hint: null },
          count,
          status: 406,
        };
      }
      return { data: list, error: null, count, status: 200 };
    } catch (error) {
      const e = error as { message?: string; code?: string; detail?: string; hint?: string };
      console.error(`[db] ${this.mode} ${this.table} failed:`, e?.message ?? error);
      return { data: null, error: { message: e?.message ?? String(error), code: e?.code, details: e?.detail ?? null, hint: e?.hint ?? null }, count: null, status: 400 };
    }
  }

  then<T1 = Result, T2 = never>(
    onfulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  catch<T = never>(onrejected?: ((reason: unknown) => T | PromiseLike<T>) | null) {
    return this.execute().catch(onrejected);
  }
}

export function createDb() {
  return { from: (table: string) => new Query(table) };
}

export type Db = ReturnType<typeof createDb>;
