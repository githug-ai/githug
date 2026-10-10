/**
 * githug in one container (docs/SELF_HOSTING.md, mode 2): the same Worker (src/worker.ts) on
 * Node, with the bindings in src/node/bindings.ts. Everything lives in GITHUG_DATA:
 *   githug.db   D1 + KV (SQLite)      r2/   hug release files (optional)
 *   enc.key     GATEWAY_ENC_KEY, generated on first start unless set in the env
 *   setup.pass  the /gateway/setup password, generated unless STATS_PASSWORD is set
 *
 * Env: PORT (8080), GITHUG_DATA (/data), GITHUG_ORIGIN, GITHUG_TRUST_PROXY=1 behind a proxy
 * that sets X-Forwarded-For, GITHUG_CRON_MINUTES (240), plus the Worker's own vars/secrets.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { SqliteD1, SqliteKV, DirR2, MemoryRateLimit, DirAssets, migrate } from "./bindings.js";
import worker from "../worker.js";

const here = dirname(fileURLToPath(import.meta.url));
// Bundled: dist/githug.mjs next to public/ and migrations/; from source: src/node/.
const appRoot = [resolve(here, ".."), resolve(here, "../..")].find((d) => existsSync(join(d, "migrations"))) ?? process.cwd();
const data = resolve(process.env.GITHUG_DATA ?? "/data");
mkdirSync(data, { recursive: true });

/** A value from the env, else one persisted in the data dir (generated on first start). */
function persisted(name: string, file: string, make: () => string): string {
  if (process.env[name]) return process.env[name]!;
  const p = join(data, file);
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  const v = make();
  writeFileSync(p, v + "\n", { mode: 0o600 });
  console.log(`githug: generated ${name} → ${p}`);
  return v;
}

const db = new SqliteD1(join(data, "githug.db"));
const applied = migrate(db, join(appRoot, "migrations"));
if (applied.length) console.log(`githug: applied ${applied.length} migration(s): ${applied.join(", ")}`);

const setupPassword = persisted("STATS_PASSWORD", "setup.pass", () => randomBytes(18).toString("base64url"));
const env: Record<string, unknown> = {
  ...process.env,
  GITHUG_MODE: process.env.GITHUG_MODE ?? "self-hosted",
  GATEWAY_ENC_KEY: persisted("GATEWAY_ENC_KEY", "enc.key", () => randomBytes(32).toString("base64")),
  STATS_USER: process.env.STATS_USER ?? "admin",
  STATS_PASSWORD: setupPassword,
  DB: db,
  CACHE: new SqliteKV(db, "CACHE"),
  RELEASES: new DirR2(join(data, "r2")),
  ASSETS: new DirAssets(join(appRoot, "public")),
  WRITE_LIMITER: new MemoryRateLimit(30, 60),
  VERIFY_LIMITER: new MemoryRateLimit(300, 60),
};
const assets = env.ASSETS as DirAssets;
const trustProxy = process.env.GITHUG_TRUST_PROXY === "1";

const pending = new Set<Promise<unknown>>();
const ctx = () => ({
  waitUntil(p: Promise<unknown>) {
    const q = p.catch((e) => console.error("waitUntil:", (e as Error)?.message ?? e)).finally(() => pending.delete(q));
    pending.add(q);
  },
  passThroughOnException() {},
  props: {},
});

function clientIp(req: IncomingMessage): string {
  const fwd = trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
  return fwd || req.socket.remoteAddress || "unknown";
}

function toRequest(req: IncomingMessage): Request {
  const proto = trustProxy && req.headers["x-forwarded-proto"] ? String(req.headers["x-forwarded-proto"]).split(",")[0] : "http";
  const host = (trustProxy && req.headers["x-forwarded-host"]) || req.headers.host || "localhost";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    // cf-* headers come from Cloudflare's edge; a client must not be able to set them here.
    if (v === undefined || k.startsWith("cf-")) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  headers.set("cf-connecting-ip", clientIp(req));
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(`${proto}://${host}${req.url ?? "/"}`, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
    // Node's fetch needs duplex for a streamed request body (not in the DOM types).
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}

async function send(res: ServerResponse, r: Response, head: boolean) {
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => {
    if (k !== "set-cookie") headers[k] = v;
  });
  const cookies: string[] = (r.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(r.status, headers);
  if (head || !r.body) return res.end();
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  res.end();
}

// Like wrangler.jsonc's assets: files under public/ first, except paths the Worker logs.
const WORKER_FIRST = new Set(["/"]);

const server = createServer(async (req, res) => {
  try {
    const path = (req.url ?? "/").split("?")[0];
    if ((req.method === "GET" || req.method === "HEAD") && !WORKER_FIRST.has(path) && assets.resolve(path)) {
      return await send(res, await assets.fetch(new URL(path, "http://x").href), req.method === "HEAD");
    }
    const r: Response = await (worker as any).fetch(toRequest(req), env, ctx());
    await send(res, r, req.method === "HEAD");
  } catch (e) {
    console.error("request failed:", (e as Error).stack ?? e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal error.");
  }
});

const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => {
  const origin = process.env.GITHUG_ORIGIN ?? `http://localhost:${port}`;
  console.log(`githug: listening on :${port} (data: ${data})`);
  if (!process.env.GITHUB_APP_ID) {
    console.log(`githug: first run? Create the GitHub App: ${origin}/gateway/setup/github-app  (user: ${env.STATS_USER}, password: ${process.env.STATS_PASSWORD ? "your STATS_PASSWORD" : `in ${join(data, "setup.pass")}`})`);
  }
});

// The Worker's cron (wrangler.jsonc → triggers): PR outcomes, scope re-checks.
const every = Math.max(5, Number(process.env.GITHUG_CRON_MINUTES ?? 240)) * 60_000;
const timer = setInterval(() => {
  (worker as any).scheduled({ cron: "node", scheduledTime: Date.now() }, env, ctx()).catch((e: Error) => console.error("scheduled failed:", e.message));
}, every);

function shutdown() {
  clearInterval(timer);
  server.close(async () => {
    await Promise.allSettled([...pending]);
    db.sqlite.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
