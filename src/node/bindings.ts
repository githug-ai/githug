/**
 * Cloudflare bindings on Node, for the one-container self-host (docs/SELF_HOSTING.md) and
 * the tests. Each implements only the slice of the binding API githug uses:
 *   D1 → SQLite (node:sqlite)   KV → a SQLite table   R2 → a directory
 *   Rate Limiting → an in-memory fixed window   Assets → files under public/
 * Dependency-free on purpose: Node 22.13+ ships node:sqlite.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync, existsSync, statSync, createReadStream, writeFileSync } from "node:fs";
import { dirname, join, resolve, extname, sep } from "node:path";
import { Readable } from "node:stream";

type Row = Record<string, unknown>;

function sqlValue(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string" || typeof v === "bigint") return v;
  if (v instanceof Uint8Array) return v;
  return String(v);
}

/**
 * D1 takes `?1`-style numbered parameters (reusable); node:sqlite binds only plain `?`
 * positionally. Rewrite numbered ones to `?` and repeat the arguments to match.
 */
function positional(sql: string, params: unknown[]): [string, SQLInputValue[]] {
  if (!/\?\d/.test(sql)) return [sql, params.map(sqlValue)];
  const args: SQLInputValue[] = [];
  let next = 0;
  const out = sql.replace(/\?(\d+)?/g, (_m, n?: string) => {
    args.push(sqlValue(params[n ? Number(n) - 1 : next++]));
    return "?";
  });
  return [out, args];
}

class Stmt {
  constructor(private db: DatabaseSync, readonly sql: string, readonly params: unknown[] = []) {}
  bind(...params: unknown[]): Stmt {
    return new Stmt(this.db, this.sql, params);
  }
  private prep() {
    const [sql, args] = positional(this.sql, this.params);
    return { stmt: this.db.prepare(sql), args };
  }
  async first<T = Row>(col?: string): Promise<T | null> {
    const { stmt, args } = this.prep();
    const r = stmt.get(...args) as Row | undefined;
    if (!r) return null;
    return (col ? r[col] : { ...r }) as T;
  }
  async all<T = Row>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    const { stmt, args } = this.prep();
    const rs = stmt.all(...args) as Row[];
    return { results: rs.map((r) => ({ ...r }) as T), success: true, meta: { changes: 0 } };
  }
  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    return this.runSync();
  }
  runSync() {
    const { stmt, args } = this.prep();
    const r = stmt.run(...args);
    return { success: true as const, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

/** D1Database over one SQLite file (":memory:" for tests). */
export class SqliteD1 {
  readonly sqlite: DatabaseSync;
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  }
  prepare(sql: string): Stmt {
    return new Stmt(this.sqlite, sql);
  }
  async batch(stmts: Stmt[]) {
    this.sqlite.exec("BEGIN");
    try {
      const out = stmts.map((s) => s.runSync());
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }
  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }
}

/** Applies migrations/*.sql in order, once each (the same files `wrangler d1 migrations` uses). */
export function migrate(db: SqliteD1, dir: string): string[] {
  db.sqlite.exec("CREATE TABLE IF NOT EXISTS d1_migrations (name TEXT PRIMARY KEY, applied_at TEXT)");
  const done = new Set((db.sqlite.prepare("SELECT name FROM d1_migrations").all() as Row[]).map((r) => String(r.name)));
  const applied: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    db.sqlite.exec("BEGIN");
    try {
      db.sqlite.exec(readFileSync(join(dir, f), "utf8"));
      db.sqlite.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)").run(f, new Date().toISOString());
      db.sqlite.exec("COMMIT");
    } catch (e) {
      db.sqlite.exec("ROLLBACK");
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
    applied.push(f);
  }
  return applied;
}

/** KVNamespace over a table in the same SQLite file; namespaces share it by prefix. */
export class SqliteKV {
  constructor(private db: SqliteD1, private ns: string) {
    db.sqlite.exec("CREATE TABLE IF NOT EXISTS kv (ns TEXT, key TEXT, value TEXT, metadata TEXT, expires INTEGER, PRIMARY KEY (ns, key))");
  }
  private row(key: string): Row | null {
    const r = this.db.sqlite.prepare("SELECT value, metadata, expires FROM kv WHERE ns = ? AND key = ?").get(this.ns, key) as Row | undefined;
    if (!r) return null;
    if (r.expires && Number(r.expires) <= Date.now()) {
      this.db.sqlite.prepare("DELETE FROM kv WHERE ns = ? AND key = ?").run(this.ns, key);
      return null;
    }
    return r;
  }
  async get(key: string, type?: string | { type?: string }): Promise<any> {
    const r = this.row(key);
    if (!r) return null;
    const t = typeof type === "string" ? type : type?.type;
    return t === "json" ? JSON.parse(String(r.value)) : String(r.value);
  }
  async getWithMetadata(key: string, type?: string) {
    const r = this.row(key);
    return { value: r ? await this.get(key, type) : null, metadata: r?.metadata ? JSON.parse(String(r.metadata)) : null };
  }
  async put(key: string, value: string, opts: { expirationTtl?: number; expiration?: number; metadata?: unknown } = {}) {
    const expires = opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : opts.expiration ? opts.expiration * 1000 : null;
    this.db.sqlite
      .prepare("INSERT INTO kv (ns,key,value,metadata,expires) VALUES (?,?,?,?,?) ON CONFLICT(ns,key) DO UPDATE SET value=excluded.value, metadata=excluded.metadata, expires=excluded.expires")
      .run(this.ns, key, String(value), opts.metadata === undefined ? null : JSON.stringify(opts.metadata), expires);
  }
  async delete(key: string) {
    this.db.sqlite.prepare("DELETE FROM kv WHERE ns = ? AND key = ?").run(this.ns, key);
  }
  async list(opts: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const limit = Math.min(opts.limit ?? 1000, 1000);
    const after = opts.cursor ?? "";
    const rs = this.db.sqlite
      .prepare("SELECT key, metadata FROM kv WHERE ns = ? AND key > ? AND key LIKE ? ESCAPE '\\' AND (expires IS NULL OR expires > ?) ORDER BY key LIMIT ?")
      .all(this.ns, after, (opts.prefix ?? "").replace(/[\\%_]/g, (m) => "\\" + m) + "%", Date.now(), limit + 1) as Row[];
    const page = rs.slice(0, limit);
    const done = rs.length <= limit;
    return {
      keys: page.map((r) => ({ name: String(r.key), metadata: r.metadata ? JSON.parse(String(r.metadata)) : undefined })),
      list_complete: done,
      cursor: done ? undefined : String(page[page.length - 1].key),
    };
  }
}

/** R2Bucket over a directory; keys map to relative paths and can't escape it. */
export class DirR2 {
  private root: string;
  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }
  private path(key: string): string | null {
    const p = resolve(this.root, key);
    return p.startsWith(this.root + sep) ? p : null;
  }
  async get(key: string) {
    const p = this.path(key);
    if (!p || !existsSync(p) || !statSync(p).isFile()) return null;
    return {
      key,
      size: statSync(p).size,
      get body() {
        return Readable.toWeb(createReadStream(p)) as unknown as ReadableStream;
      },
      text: async () => readFileSync(p, "utf8"),
      arrayBuffer: async () => new Uint8Array(readFileSync(p)).buffer,
    };
  }
  async put(key: string, value: string | Uint8Array | ArrayBuffer) {
    const p = this.path(key);
    if (!p) throw new Error(`bad R2 key: ${key}`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof value === "string" ? value : new Uint8Array(value as ArrayBuffer));
  }
}

/** Rate Limiting binding: fixed window per key, in this process. */
export class MemoryRateLimit {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private limitN: number, private periodS: number) {}
  async limit({ key }: { key: string }) {
    const now = Date.now();
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || h.reset <= now) {
      this.hits.set(key, { n: 1, reset: now + this.periodS * 1000 });
      return { success: true };
    }
    h.n++;
    return { success: h.n <= this.limitN };
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
};

/** The Assets binding: files under public/, with Cloudflare's /x → x.html and /x/ → x/index.html. */
export class DirAssets {
  private root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  /** The file a path would serve, or null. */
  resolve(pathname: string): string | null {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (rel.split("/").some((s) => s.startsWith(".") && s.length > 0 && !s.startsWith(".well-known"))) return null;
    const candidates = rel.endsWith("/") ? [rel + "index.html"] : [rel, rel + ".html", rel + "/index.html"];
    for (const c of candidates) {
      const p = resolve(this.root, "." + c);
      if (p.startsWith(this.root + sep) && existsSync(p) && statSync(p).isFile() && !p.endsWith(sep + "_headers")) return p;
    }
    return null;
  }
  async fetch(input: Request | string): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input.url);
    const p = this.resolve(url.pathname);
    if (!p) return new Response("Not found.", { status: 404 });
    return new Response(readFileSync(p), { headers: { "Content-Type": TYPES[extname(p).toLowerCase()] ?? "application/octet-stream" } });
  }
}
