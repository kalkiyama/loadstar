import { Router } from "express";
import { pool, audit, browserWorkerAvailable } from "../db.js";
import { validateTestInput } from "../middleware/security.js";
import { generateJmx } from "../services/jmxGenerator.js";
import { generateK6Script } from "../services/k6Generator.js";
import {
  getOrCreateToken,
  attemptVerification,
  isTargetAllowed,
} from "../services/targetVerification.js";
import { analyzeRun } from "../services/claudeAnalyst.js";
import { checkScript } from "../services/scriptCheck.js";
import { isValidWebhookUrl } from "../services/notify.js";
import { renderReportHtml } from "../services/reportHtml.js";
import { buildPptx } from "../services/pptxReport.js";
import { getRunHistory } from "../services/emailReport.js";

const r = Router();

/* ---------- Mock auth (test-only, gated by ENABLE_MOCK_AUTH) ----------
   Proves response chaining: /mock/login returns a token in JSON *and* a
   Set-Cookie; /mock/protected requires either to succeed. Never enabled
   in production — only when ENABLE_MOCK_AUTH=true. */
if (process.env.ENABLE_MOCK_AUTH === "true") {
  r.post("/mock/login", (req, res) => {
    const token = "tok_" + Math.random().toString(36).slice(2, 10);
    res.setHeader("Set-Cookie", `session=${token}; Path=/; HttpOnly`);
    res.json({ token, user: (req.body && req.body.user) || "demo" });
  });
  r.post("/mock/webhook-catch", (req, res) => {
    console.log("[webhook-catch] RECEIVED:", JSON.stringify(req.body));
    res.json({ received: true });
  });
  r.get("/mock/protected", (req, res) => {
    const auth = req.headers["authorization"] || "";
    const cookie = req.headers["cookie"] || "";
    const okBearer = auth.startsWith("Bearer tok_");
    const okCookie = cookie.includes("session=tok_");
    if (okBearer || okCookie) return res.json({ ok: true, via: okBearer ? "bearer" : "cookie" });
    return res.status(401).json({ ok: false, error: "missing or invalid token" });
  });
}

/* ---------- Tests ---------- */

r.post("/tests/upload-script", async (req, res) => {
  const b = req.body || {};
  const name = (b.name || "").toString().trim();
  const script = (b.script || "").toString();
  const targetUrl = (b.target_url || "").toString().trim();
  const engineHint = b.engine === "k6" ? "k6" : b.engine === "jmeter" ? "jmeter" : null;
  if (!name) return res.status(400).json({ error: "A test name is required." });
  if (!script.trim()) return res.status(400).json({ error: "The uploaded script is empty." });
  if (script.length > 5_000_000) return res.status(400).json({ error: "Script too large (5MB limit)." });

  const { engine, warnings } = checkScript(script, engineHint);
  if (engine !== "jmeter" && engine !== "k6") {
    return res.status(400).json({ error: "Could not identify a JMeter (.jmx) or k6 (.js) script. Select the engine explicitly if needed." });
  }
  const q = await pool.query(
    `INSERT INTO tests (name, target_url, method, headers, mode, virtual_users, ramp_up_secs, duration_secs, test_type, engine, uploaded_script, script_warnings)
     VALUES ($1,$2,'GET','{}','load',1,0,0,'script',$3,$4,$5) RETURNING *`,
    [name, targetUrl || "http://uploaded-script", engine, script, warnings.length ? warnings.join("\n") : null]
  );
  await audit("api", "test.uploaded", q.rows[0].id, { name, engine, warnings: warnings.length });
  res.status(201).json({ ...q.rows[0], warnings });
});

r.post("/tests", async (req, res) => {
  const err = validateTestInput(req.body);
  if (err) return res.status(400).json({ error: err });
  const b = req.body;

  // Browser-under-load: create a hidden companion http load test first.
  let companionId = null;
  if (b.test_type === "browser" && b.background_load) {
    const bg = b.background_load;
    const bgUsers = Number(bg.virtual_users);
    const bgDur = Number(bg.duration_secs);
    const maxVu = Number(process.env.MAX_VIRTUAL_USERS || 500);
    if (!Number.isInteger(bgUsers) || bgUsers < 1 || bgUsers > maxVu)
      return res.status(400).json({ error: `background_load.virtual_users must be 1–${maxVu}.` });
    if (!Number.isInteger(bgDur) || bgDur < 10 || bgDur > Number(process.env.MAX_DURATION_SECS || 3600))
      return res.status(400).json({ error: "background_load.duration_secs out of range." });
    const c = await pool.query(
      `INSERT INTO tests (name, target_url, method, headers, mode, virtual_users, ramp_up_secs, duration_secs, test_type, hidden)
       VALUES ($1,$2,'GET','{}','load',$3,10,$4,'http',TRUE) RETURNING id`,
      [`${b.name} — background load`, b.target_url, bgUsers, bgDur]
    );
    companionId = c.rows[0].id;
  }
  const q = await pool.query(
    `INSERT INTO tests (name, target_url, method, headers, body, mode, virtual_users, ramp_up_secs, duration_secs, csv_data, test_type, browser_steps, loops, companion_test_id, notify_email, engine, sla, requests, browser, distribution_mode, shard_count_override)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
    [
      b.name,
      b.target_url,
      b.method || "GET",
      JSON.stringify(b.headers || {}),
      b.body || null,
      b.mode || "load",
      b.virtual_users ?? (b.test_type === "browser" ? 1 : 10),
      b.ramp_up_secs ?? 30,
      b.duration_secs ?? 120,
      b.csv_data || null,
      b.test_type === "browser" ? "browser" : "http",
      b.browser_steps ? JSON.stringify(b.browser_steps) : null,
      b.loops ?? 1,
      companionId,
      b.notify_email || null,
      b.engine === "k6" ? "k6" : b.test_type === "browser" ? "playwright" : "jmeter",
      b.sla ? JSON.stringify(b.sla) : null,
      b.requests ? JSON.stringify(b.requests) : null,
      ["chromium", "firefox", "webkit"].includes(b.browser) ? b.browser : "chromium",
      ["auto", "on", "off"].includes(b.distribution_mode) ? b.distribution_mode : "auto",
      Number.isInteger(Number(b.shard_count_override)) && Number(b.shard_count_override) > 1 ? Number(b.shard_count_override) : null,
    ]
  );
  await audit("api", "test.created", q.rows[0].id, { name: b.name });
  res.status(201).json(q.rows[0]);
});

/* The effective limits, so the UI never hardcodes them again. Previously the caps
   lived in THREE places — .env, the validator, and hardcoded HTML max="" attributes —
   and they had already drifted: .env.example said 1000 VUs while the form silently
   capped at 500. One source of truth. */
r.get("/config", (_req, res) => {
  res.json({
    max_virtual_users: Number(process.env.MAX_VIRTUAL_USERS || 500),
    max_duration_secs: Number(process.env.MAX_DURATION_SECS || 3600),
    distribution_vu_threshold: Number(process.env.DISTRIBUTION_VU_THRESHOLD || 100),
    max_shards: Number(process.env.MAX_SHARDS || 10),
    max_browser_users: Number(process.env.MAX_BROWSER_USERS || 5),
    max_browser_loops: Number(process.env.MAX_BROWSER_LOOPS || 10),
  });
});

r.get("/tests", async (_req, res) => {
  const q = await pool.query("SELECT * FROM tests WHERE hidden=FALSE ORDER BY created_at DESC LIMIT 100");
  res.json(q.rows);
});

/* Refuse work the browser worker cannot do, AT QUEUE TIME.
   Without this the API cheerfully accepted five PDF exports against a worker that
   had crashed on startup, and the UI said "a real browser is printing your report"
   for an hour. The distributed path already does exactly this for shard counts;
   browser work had no equivalent.
   Names the cause, the reason, and the command — the shard message does, and that
   is why it was useful when it fired. */
const NO_BROWSER_WORKER =
  "No browser worker is running. This needs the worker-browser container, which " +
  "drives a real browser. Start it with: docker compose up -d worker-browser " +
  "(or use Start Loadstar, which brings up everything).";

r.get("/tests/:id/jmx", async (req, res) => {
  const q = await pool.query("SELECT * FROM tests WHERE id=$1", [req.params.id]);
  if (!q.rows[0]) return res.status(404).json({ error: "Test not found" });
  if (q.rows[0].test_type === "browser")
    return res.status(400).json({ error: "Browser tests run on Playwright — there is no JMeter plan to download." });
  res.type("application/xml")
    .set("Content-Disposition", `attachment; filename="loadstar-${req.params.id.slice(0,8)}.jmx"`)
    .send(generateJmx(q.rows[0]));
});

r.get("/tests/:id/k6", async (req, res) => {
  const q = await pool.query("SELECT * FROM tests WHERE id=$1", [req.params.id]);
  if (!q.rows[0]) return res.status(404).json({ error: "Test not found" });
  if (q.rows[0].test_type === "browser")
    return res.status(400).json({ error: "Browser tests run on Playwright — no k6 script." });
  res.type("application/javascript")
    .set("Content-Disposition", `attachment; filename="loadstar-${req.params.id.slice(0,8)}.js"`)
    .send(generateK6Script(q.rows[0]));
});

r.delete("/tests/:id", async (req, res) => {
  // Also removes hidden companion (browser-under-load) and cascades runs/schedules via FK.
  const t = await pool.query("SELECT companion_test_id FROM tests WHERE id=$1", [req.params.id]);
  if (!t.rows[0]) return res.status(404).json({ error: "Test not found" });
  if (t.rows[0].companion_test_id)
    await pool.query("DELETE FROM tests WHERE id=$1", [t.rows[0].companion_test_id]);
  await pool.query("DELETE FROM tests WHERE id=$1", [req.params.id]);
  await audit("api", "test.deleted", req.params.id);
  res.json({ deleted: true });
});

/* ---------- Runs ---------- */

r.post("/tests/:id/runs", async (req, res) => {
  const t = await pool.query("SELECT * FROM tests WHERE id=$1", [req.params.id]);
  if (!t.rows[0]) return res.status(404).json({ error: "Test not found" });

  const gate = await isTargetAllowed(t.rows[0].target_url);
  if (!gate.allowed) return res.status(403).json({ error: gate.reason });
  if (t.rows[0].test_type === "browser" && !(await browserWorkerAvailable()))
    return res.status(503).json({ error: NO_BROWSER_WORKER });
  const debug = (req.body && req.body.debug === true) || false;

  // Browser-under-load: fire the background load run first so pressure is
  // already building while the browser flow is measured.
  let companionRunId = null;
  if (t.rows[0].companion_test_id) {
    const c = await pool.query("INSERT INTO runs (test_id) VALUES ($1) RETURNING id", [
      t.rows[0].companion_test_id,
    ]);
    companionRunId = c.rows[0].id;
  }

  // compare_to: pin this run's comparison to a specific earlier run (e.g. CI
  // comparing a PR build against the main build) without touching the baseline.
  let compareTo = null;
  if (req.body && req.body.compare_to) {
    const c = await pool.query("SELECT id FROM runs WHERE id=$1 AND test_id=$2 AND status='done'", [req.body.compare_to, req.params.id]);
    if (!c.rows[0]) return res.status(400).json({ error: "compare_to must be a completed run of this test." });
    compareTo = c.rows[0].id;
  }
  const q = await pool.query(
    "INSERT INTO runs (test_id, companion_run_id, debug, compare_to) VALUES ($1,$2,$3,$4) RETURNING *",
    [req.params.id, companionRunId, debug, compareTo]
  );
  await audit("api", "run.queued", q.rows[0].id, { test_id: req.params.id, companion_run_id: companionRunId, debug });
  res.status(202).json(q.rows[0]);
});

/* ---------- Schedules (regression runs + alerts) ---------- */

r.post("/schedules", async (req, res) => {
  const { test_id, interval_minutes, webhook_url } = req.body || {};
  const t = await pool.query("SELECT id FROM tests WHERE id=$1", [test_id]);
  if (!t.rows[0]) return res.status(404).json({ error: "Test not found" });
  const mins = Number(interval_minutes);
  if (!Number.isInteger(mins) || mins < 5 || mins > 10080)
    return res.status(400).json({ error: "interval_minutes must be between 5 and 10080 (one week)." });
  if (webhook_url && !isValidWebhookUrl(webhook_url))
    return res.status(400).json({ error: "webhook_url must be a valid, non-private http(s) URL." });
  const q = await pool.query(
    "INSERT INTO schedules (test_id, interval_minutes, webhook_url) VALUES ($1,$2,$3) RETURNING *",
    [test_id, mins, webhook_url || null]
  );
  await audit("api", "schedule.created", q.rows[0].id, { test_id, interval_minutes: mins });
  res.status(201).json(q.rows[0]);
});

r.get("/schedules", async (_req, res) => {
  const q = await pool.query(
    `SELECT s.*, t.name AS test_name, t.test_type
     FROM schedules s JOIN tests t ON t.id = s.test_id
     ORDER BY s.created_at DESC LIMIT 100`
  );
  res.json(q.rows);
});

r.delete("/schedules/:id", async (req, res) => {
  await pool.query("DELETE FROM schedules WHERE id=$1", [req.params.id]);
  await audit("api", "schedule.deleted", req.params.id);
  res.json({ deleted: true });
});

r.get("/runs/:id", async (req, res) => {
  const q = await pool.query(
    `SELECT runs.*, tests.name AS test_name, tests.mode, tests.virtual_users,
            tests.target_url, tests.test_type, tests.loops, tests.browser, tests.engine
     FROM runs JOIN tests ON tests.id = runs.test_id WHERE runs.id=$1`,
    [req.params.id]
  );
  if (!q.rows[0]) return res.status(404).json({ error: "Run not found" });
  res.json(q.rows[0]);
});

r.get("/runs", async (_req, res) => {
  const q = await pool.query(
    `SELECT runs.id, runs.status, runs.created_at, runs.finished_at,
            runs.summary, tests.name AS test_name, tests.mode, tests.test_type, tests.browser, tests.engine
     FROM runs JOIN tests ON tests.id = runs.test_id
     WHERE runs.shard_of IS NULL
     ORDER BY runs.created_at DESC LIMIT 100`
  );
  res.json(q.rows);
});

/* ---------- Report exports ---------- */

async function loadFullRun(runId) {
  const q = await pool.query(
    `SELECT runs.*, to_jsonb(tests.*) AS test FROM runs
     JOIN tests ON tests.id = runs.test_id WHERE runs.id=$1`,
    [runId]
  );
  const run = q.rows[0];
  if (!run || !["done", "cancelled"].includes(run.status)) return null;
  const history = await getRunHistory(run.test_id, run.id, 5, run.compare_to);
  return { run, test: run.test, summary: run.summary, timeseries: run.timeseries || [], analysis: run.ai_analysis, history };
}

r.get("/runs/:id/export/html", async (req, res) => {
  const full = await loadFullRun(req.params.id);
  if (!full) return res.status(404).json({ error: "Run not found or not finished." });
  const html = renderReportHtml(full);
  await audit("api", "export.html", req.params.id);
  res.setHeader("Content-Disposition", `attachment; filename="loadstar-report-${req.params.id.slice(0, 8)}.html"`);
  res.type("html").send(html);
});

r.get("/runs/:id/export/pptx", async (req, res) => {
  const full = await loadFullRun(req.params.id);
  if (!full) return res.status(404).json({ error: "Run not found or not finished." });
  const buf = await buildPptx(full);
  await audit("api", "export.pptx", req.params.id);
  res.setHeader("Content-Disposition", `attachment; filename="loadstar-report-${req.params.id.slice(0, 8)}.pptx"`);
  res.type("application/vnd.openxmlformats-officedocument.presentationml.presentation").send(buf);
});

/* Mark a run as this test's baseline — the "known good" reference for future
   comparisons. Only one baseline per test (enforced by a partial unique index),
   so setting a new one clears the old. */
/* Stop a running (or queued, or coordinating) test. Sets a flag the worker polls;
   the worker kills the engine subprocess and marks the run 'cancelled'. A queued run
   is cancelled outright since no worker has claimed it. For a distributed run, the
   parent's shards are flagged too so each generator stops. */
r.post("/runs/:id/cancel", async (req, res) => {
  const q = await pool.query("SELECT id, status FROM runs WHERE id=$1", [req.params.id]);
  const run = q.rows[0];
  if (!run) return res.status(404).json({ error: "Run not found." });
  if (!["queued", "running", "coordinating", "analyzing"].includes(run.status))
    return res.status(400).json({ error: `Run is ${run.status} — only a queued, running, or coordinating run can be stopped.` });

  if (run.status === "queued") {
    // No worker has it yet: cancel outright so it is never claimed.
    await pool.query("UPDATE runs SET status='cancelled', finished_at=now(), error='Stopped before it started' WHERE id=$1 AND status='queued'", [run.id]);
  } else {
    await pool.query("UPDATE runs SET cancel_requested=TRUE WHERE id=$1", [run.id]);
    // Distributed run: flag the shards too, so each generator stops its own engine.
    await pool.query("UPDATE runs SET cancel_requested=TRUE WHERE shard_of=$1 AND status IN ('queued','running')", [run.id]);
  }
  await audit("api", "run.cancel.requested", run.id, { was: run.status });
  res.json({ ok: true, status: run.status === "queued" ? "cancelled" : "stopping" });
});

/* A baseline is a PROMISE: "this is the known-good reference, forever". claudeAnalyst
   compares every future run against it. Anchor it to a run whose numbers Loadstar itself
   calls unreliable and every future verdict is measured against junk — silently.

   So: refuse a saturated run, and say why. `force: true` overrides — someone whose only
   generator IS saturated still needs a baseline, and blocking them outright just gets the
   tool forked. But a forced baseline is audited as a DISTINCT event and reported back, so
   it can never be mistaken for a clean one.

   Runs baselined BEFORE the saturation fix (July 12) carry the old broken reading — a 60s
   load average that could not resolve a 15-30s test. Those are not silently trusted either:
   they get their own warning, because an unreliable metric is unreliable in BOTH directions. */
r.post("/runs/:id/baseline", async (req, res) => {
  const q = await pool.query("SELECT id, test_id, status, summary FROM runs WHERE id=$1", [req.params.id]);
  const run = q.rows[0];
  if (!run) return res.status(404).json({ error: "Run not found." });
  if (run.status !== "done") return res.status(400).json({ error: "Only a completed run can be a baseline." });

  const gen = (run.summary && run.summary.generator) || null;
  const force = req.body && req.body.force === true;

  // A run measured by the OLD (broken) metric has no `metric` field.
  const staleMetric = gen && !gen.metric;

  if (gen && gen.saturated === true && !force) {
    return res.status(400).json({
      error:
        "This run's load generator was saturated, so its latency and throughput numbers are " +
        "unreliable — they describe the generator, not the target. A baseline is the reference " +
        "every future run is compared against, so anchoring it here would quietly poison every " +
        "future verdict. Re-run with fewer virtual users, add think time, or use more generators " +
        "\u2014 or send force: true to set it anyway.",
      reason: "generator_saturated",
      generator: gen,
      can_force: true,
    });
  }

  await pool.query("UPDATE runs SET is_baseline=FALSE WHERE test_id=$1 AND is_baseline", [run.test_id]);
  await pool.query("UPDATE runs SET is_baseline=TRUE WHERE id=$1", [run.id]);

  const forced = force && gen && gen.saturated === true;
  await audit("api", forced ? "run.baseline.forced" : "run.baseline.set", run.id, {
    test_id: run.test_id,
    saturated: gen ? gen.saturated === true : null,
    metric: gen ? gen.metric || "pre-fix" : null,
  });

  const out = { ok: true, baseline_run_id: run.id };
  if (forced) {
    out.forced = true;
    out.warning =
      "Baseline set on a SATURATED run. Its numbers describe the load generator, not the " +
      "target. Future comparisons against it will be misleading.";
  } else if (staleMetric) {
    out.warning =
      "This run predates the July 2026 saturation fix, so its generator reading came from a " +
      "60-second load average that could not resolve a 15-30 second test. That reading is " +
      "unreliable in BOTH directions. Consider re-running and re-baselining.";
  }
  res.json(out);
});

/* Clear the baseline for a test. */
r.delete("/runs/:id/baseline", async (req, res) => {
  const q = await pool.query("SELECT test_id FROM runs WHERE id=$1", [req.params.id]);
  if (!q.rows[0]) return res.status(404).json({ error: "Run not found." });
  await pool.query("UPDATE runs SET is_baseline=FALSE WHERE test_id=$1 AND is_baseline", [q.rows[0].test_id]);
  await audit("api", "run.baseline.cleared", req.params.id, {});
  res.json({ ok: true });
});

r.post("/runs/:id/export/pdf", async (req, res) => {
  const full = await loadFullRun(req.params.id);
  if (!full) return res.status(404).json({ error: "Run not found or not finished." });
  if (!(await browserWorkerAvailable())) return res.status(503).json({ error: NO_BROWSER_WORKER });
  const q = await pool.query("INSERT INTO exports (run_id, format) VALUES ($1,'pdf') RETURNING id", [req.params.id]);
  await audit("api", "export.pdf.queued", req.params.id);
  res.status(202).json({ id: q.rows[0].id });
});

r.post("/runs/:id/export/email", async (req, res) => {
  const full = await loadFullRun(req.params.id);
  if (!full) return res.status(404).json({ error: "Run not found or not finished." });
  const to = (req.body?.to || full.test.notify_email || process.env.REPORT_EMAIL_TO || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))
    return res.status(400).json({ error: "Provide a recipient: no valid email configured for this test." });
  // Same queue, same worker as the PDF export: the email bundle builds HTML + PDF
  // + PowerPoint, and the PDF half needs a real browser.
  if (!(await browserWorkerAvailable())) return res.status(503).json({ error: NO_BROWSER_WORKER });
  const q = await pool.query(
    "INSERT INTO exports (run_id, format, detail) VALUES ($1,'email_bundle',$2) RETURNING id",
    [req.params.id, JSON.stringify({ to })]
  );
  await audit("api", "export.email.queued", req.params.id, { to });
  res.status(202).json({ id: q.rows[0].id, to });
});

r.get("/exports/:id", async (req, res) => {
  const q = await pool.query("SELECT id, run_id, format, status, error, filename FROM exports WHERE id=$1", [req.params.id]);
  if (!q.rows[0]) return res.status(404).json({ error: "Export not found" });
  res.json(q.rows[0]);
});

r.get("/exports/:id/download", async (req, res) => {
  const q = await pool.query("SELECT * FROM exports WHERE id=$1", [req.params.id]);
  const e = q.rows[0];
  if (!e || e.status !== "done" || !e.file) return res.status(404).json({ error: "File not ready." });
  res.setHeader("Content-Disposition", `attachment; filename="${e.filename || "loadstar-export"}"`);
  res.type(e.format === "pdf" ? "application/pdf" : "application/octet-stream").send(e.file);
});

/* ---------- AI analysis (on-demand or re-run) ---------- */

r.post("/runs/:id/analyze", async (req, res) => {
  const q = await pool.query(
    `SELECT runs.*, tests.mode, tests.virtual_users, tests.ramp_up_secs,
            tests.duration_secs, tests.method
     FROM runs JOIN tests ON tests.id = runs.test_id WHERE runs.id=$1`,
    [req.params.id]
  );
  const run = q.rows[0];
  if (!run) return res.status(404).json({ error: "Run not found" });
  if (run.status !== "done") return res.status(409).json({ error: "Run is not finished yet." });

  const analysis = await analyzeRun({
    test: run,
    summary: run.summary,
    timeseries: run.timeseries || [],
  });
  await pool.query("UPDATE runs SET ai_analysis=$1 WHERE id=$2", [
    JSON.stringify(analysis),
    run.id,
  ]);
  await audit("api", "run.analyzed", run.id);
  res.json(analysis);
});

/* ---------- Target verification (anti-abuse) ---------- */

r.post("/targets/verify", async (req, res) => {
  const { domain } = req.body || {};
  if (!domain || /[/\s]/.test(domain))
    return res.status(400).json({ error: "Provide a bare domain, e.g. { \"domain\": \"example.com\" }" });
  const row = await getOrCreateToken(domain);
  if (row.verified) return res.json({ verified: true, domain });
  const result = await attemptVerification(domain);
  res.json({
    domain,
    ...result,
    instructions: result.verified
      ? undefined
      : `Serve the token below as plain text at https://${domain}/.well-known/loadstar-verify.txt then call this endpoint again.`,
    token: result.verified ? undefined : row.token,
  });
});

/* Async-error shield: any rejected route handler flows to Express's error
   handler as a 500 instead of crashing the process. */
for (const layer of r.stack) {
  for (const l of layer.route?.stack || []) {
    const fn = l.handle;
    l.handle = (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  }
}

export default r;
