import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgres://loadstar:loadstar@localhost:5432/loadstar",
  max: 10,
});

/** Run every .sql file in /migrations in filename order. Idempotent. */
export async function migrate() {
  const dir = path.join(__dirname, "..", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    await pool.query(sql);
  }
  console.log(`[db] migrations applied: ${files.join(", ")}`);
}

export async function audit(actor, action, entity, detail = {}) {
  await pool.query(
    "INSERT INTO audit_log (actor, action, entity, detail) VALUES ($1,$2,$3,$4)",
    [actor, action, entity, JSON.stringify(detail)]
  );
}

/**
 * The load profile of a test AS EXECUTED. Snapshotted onto each run at
 * completion by the workers, so later edits to a test can never retroactively
 * rewrite what a historical run actually did.
 *
 * Counts and timing only — never headers or bodies, which routinely carry
 * auth tokens and would leak into AI prompts and stored history.
 */
export function loadProfile(test) {
  if (!test) return null;
  const p = { engine: test.engine || "jmeter", mode: test.mode || null };
  if (test.test_type === "browser") {
    p.users = test.virtual_users ?? null;
    p.loops = test.loops ?? null;
    p.steps = Array.isArray(test.browser_steps) ? test.browser_steps.length : 0;
    p.browser = test.browser || null;
    return p;
  }
  p.virtual_users = test.virtual_users ?? null;
  p.duration_secs = test.duration_secs ?? null;
  p.ramp_up_secs = test.ramp_up_secs ?? null;
  const reqs = Array.isArray(test.requests) ? test.requests : [];
  p.requests = reqs.length || 1;
  const tt = reqs.filter((r) => Number(r.think_time_ms) > 0);
  if (tt.length) {
    const ms = [...new Set(tt.map((r) => Number(r.think_time_ms)))].join("/");
    const jit = [...new Set(tt.map((r) => Number(r.think_time_jitter_pct) || 0))].join("/");
    p.think_time = `${ms}ms ±${jit}% on ${tt.length}/${reqs.length} requests`;
  }
  if (reqs.some((r) => r.extract)) p.response_chaining = true;
  return p;
}

/**
 * Render a latency value. Percentiles come from a 1ms-bucket histogram
 * (worker.js), so anything below 1ms is genuinely below the instrument's
 * resolution — "0 ms" would claim zero latency, which is never true.
 */
export const fmtMs = (v) => (v == null ? "—" : Number(v) < 1 ? "<1 ms" : `${v} ms`);

/* ————— live worker counting —————
   ONE implementation, imported by the API and by both workers. worker.js had its
   own copy hardcoded to kind='http'; browserWorker.js had none, and api/src never
   queried the table at all — so nothing anywhere could answer "is a browser worker
   alive?". The PDF queue therefore accepted five jobs it could not serve and the UI
   said "a real browser is printing your report" for an hour.

   Duplicating this would repeat the verify_ssrf.mjs drift: two copies of the same
   rule, one of them quietly wrong.

   Migration 019 gave `workers` a `kind` column defaulting to 'http' — the second
   kind was anticipated and never wired. */
export const WORKER_STALE_MS = Number(process.env.WORKER_STALE_MS || 30000);

/* Dead container IDs accumulate one row forever: 13 stale of 15 after three days
   of rebuilds, since every rebuild produces a new hostname. Nothing breaks — every
   query filters on last_seen — but the table only grows.

   Pruned from inside the beat rather than on a timer: there is no new scheduling to
   get out of order, and both workers already call this. Probabilistic (~1 beat in
   50) because a DELETE from every worker every 5 seconds would be 98% no-ops.

   10 minutes, not the 30s stale window: a worker that is merely slow, paused, or
   mid-restart must never have its row removed out from under it. This only clears
   IDs that are long gone. */
export async function beatWorker(id, kind = "http") {
  await pool.query(
    "INSERT INTO workers (id, kind, last_seen) VALUES ($1, $2, now()) " +
      "ON CONFLICT (id) DO UPDATE SET last_seen = now(), kind = EXCLUDED.kind",
    [id, kind]
  );
  if (Math.random() < 0.02) {
    await pool
      .query("DELETE FROM workers WHERE last_seen < now() - interval '10 minutes'")
      .catch(() => {});   // housekeeping must never break a heartbeat
  }
}

export async function liveWorkers(kind = "http", staleMs = WORKER_STALE_MS) {
  const q = await pool.query(
    "SELECT count(*)::int AS n FROM workers WHERE kind=$1 AND last_seen > now() - ($2 || ' milliseconds')::interval",
    [kind, String(staleMs)]
  );
  return (q.rows[0] && q.rows[0].n) || 0;
}

/* Deliberately fails OPEN, unlike the shard pre-flight.
   A missing SHARD deadlocks: rows are created and nobody claims them, so refusing
   is the safe direction. A missing BROWSER WORKER just means a job waits — and if
   this check itself errors, refusing would break PDF export on a perfectly healthy
   install. So: refuse only when we positively know nothing has beaten. */
export async function browserWorkerAvailable() {
  try {
    return (await liveWorkers("browser")) > 0;
  } catch (e) {
    console.warn(`[db] browser-worker check failed, assuming available: ${e.message}`);
    return true;
  }
}
