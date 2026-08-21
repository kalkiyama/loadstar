/**
 * Loadstar browser worker — executes browser (functional/UI) tests.
 *
 * Users define no-code steps in the UI; this worker interprets them with
 * Playwright: N parallel users × M loops, per-step timings, a screenshot on
 * the first failure per user, aggregated results, then Claude analysis.
 *
 * Engine note: steps are engine-agnostic on purpose. `tests.browser_engine`
 * defaults to 'playwright'; a Selenium executor can implement the same step
 * contract later without touching the UI or schema.
 */
import { chromium, firefox, webkit } from "playwright";
/** Launch the Playwright engine chosen for this test. Defaults to Chromium. */
const ENGINES = { chromium, firefox, webkit };
function launchBrowser(name) {
  const engine = ENGINES[name] || chromium;
  const opts = name === "firefox" || name === "webkit"
    ? {} // these engines reject Chromium's --no-sandbox/--disable-dev-shm-usage
    : { args: ["--no-sandbox", "--disable-dev-shm-usage"] };
  return engine.launch(opts);
}

import os from "node:os";
import { pool, loadProfile, beatWorker } from "../api/src/db.js";
import { analyzeRun } from "../api/src/services/claudeAnalyst.js";
import { notifyRunResult } from "../api/src/services/notify.js";
import { getRunHistory, sendRunEmail } from "../api/src/services/emailReport.js";
import { renderReportHtml } from "../api/src/services/reportHtml.js";
import { buildPptx } from "../api/src/services/pptxReport.js";
import { evaluateSla } from "../api/src/services/sla.js";
import nodemailer from "nodemailer";

const POLL_MS = 3000;
const STEP_TIMEOUT_MS = Number(process.env.BROWSER_STEP_TIMEOUT_MS || 15000);
const MAX_SCREENSHOTS = 3;

async function claimNextRun() {
  const q = await pool.query(`
    UPDATE runs SET status='running', started_at=now()
    WHERE id = (
      SELECT runs.id FROM runs JOIN tests ON tests.id = runs.test_id
      WHERE runs.status='queued' AND tests.test_type='browser'
      ORDER BY runs.created_at LIMIT 1 FOR UPDATE OF runs SKIP LOCKED
    )
    RETURNING *`);
  return q.rows[0] || null;
}

async function execStep(page, step) {
  const t = { timeout: STEP_TIMEOUT_MS };
  switch (step.action) {
    case "goto":        return page.goto(step.value, { ...t, waitUntil: "domcontentloaded" });
    case "click":       return page.click(step.selector, t);
    case "fill":        return page.fill(step.selector, step.value, t);
    case "wait_for": {
      /* .filter({ visible: true }) BEFORE .first(). waitForSelector takes the first
         match in DOM ORDER and waits only on that one. On jkcc.ac.in "Mission" matched
         six elements: #1 was a dropdown link that only renders on hover, #6 was a plain
         <h3> heading in the page body. Loadstar waited 30s on the hover-only link and
         reported the text missing, while a perfectly visible heading sat further down.
         "Does this appear on the page" means ANY visible match, not the first one. */
      const wres = await waitForAnyVisible(page.locator(step.selector), STEP_TIMEOUT_MS);
      if (!wres.ok) throw new Error(describeNoVisible(`"${step.selector}"`, wres.inDom));
      return;
    }
    case "pause":       return page.waitForTimeout(Number(step.value));
    case "expect_text": {
      const eres = await waitForAnyVisible(page.getByText(step.value, { exact: false }), STEP_TIMEOUT_MS);
      if (!eres.ok) throw new Error(describeNoVisible(`the text "${step.value}"`, eres.inDom));
      return;
    }
    case "expect_no_text": {
      // The text must NOT be on the page. Give the page a moment to settle first,
      // then check — otherwise we'd pass simply because it hasn't rendered yet.
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      const appeared = await page
        .getByText(step.value, { exact: false })
        .first()
        .waitFor({ timeout: 2000, state: "visible" })
        .then(() => true)
        .catch(() => false);
      if (appeared) throw new Error(`Did not expect to see "${step.value}" on the page, but it was there.`);
      return;
    }
    case "expect_visible": {
      /* Same any-visible rule as the text steps, deliberately. A precise selector
         matches one element and behaves identically; a loose one gets the same honest
         answer instead of silently waiting on match #0. This is also the step to reach
         for when a specific occurrence is wanted — h3:has-text("Mission"), or
         .content >> text=Mission — since it takes a raw CSS/Playwright selector. */
      const vres = await waitForAnyVisible(page.locator(step.selector), STEP_TIMEOUT_MS);
      if (!vres.ok) throw new Error(describeNoVisible(`"${step.selector}"`, vres.inDom));
      return;
    }
    case "expect_url": {
      const ok = await page
        .waitForURL((u) => String(u).includes(step.value), t)
        .then(() => true)
        .catch(() => false);
      if (!ok) throw new Error(`Expected the URL to contain "${step.value}", but it was "${page.url()}".`);
      return;
    }
    default: throw new Error(`Unknown action: ${step.action}`);
  }
}

/* Playwright tells the truth; we were throwing it away.
   A `text=` locator that matches several elements picks the FIRST and waits for it to
   be visible. On a real site "Mission" matched six elements, the first being a link in
   a collapsed menu — so the step timed out and Loadstar reported "it never appeared"
   about text that appeared six times. That is a simpler-but-false report replacing a
   confusing-but-true one, which is the one thing this project must not do.
   Three states, and they are NOT the same thing:
     nothing matched          -> "never appeared" is TRUE, say it
     matched but never shown  -> the text IS there and hidden; say THAT
     matched and visible      -> pass
   A hidden match still FAILS the step: a functional test asserting the user sees
   something should fail when the user cannot. Only the wording changes. */
/* Wait until ANY match is visible — not the first one in DOM order.
   waitForSelector and .first() both take match #0 and wait only on that. On
   jkcc.ac.in "Mission" matched six elements: #0 and #1 were hover-only dropdown
   links, while #2, #3 and #5 (an <h3> heading in the page body) were plainly
   visible. Loadstar waited 30s on a hover-only link and reported the text missing.
   locator.filter({ visible: true }) is NOT available in Playwright 1.47 — it is
   accepted and silently ignored, returning the unfiltered count. Verified against
   this exact page: filtered count 6, unfiltered count 6. So poll instead; it
   depends on no version-specific API.
   Returns { ok, inDom, visibleCount } so the caller can tell "absent" from
   "present but never shown". */
async function waitForAnyVisible(loc, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let inDom = 0;
  while (Date.now() < deadline) {
    inDom = await loc.count().catch(() => 0);
    for (let i = 0; i < inDom; i++) {
      if (await loc.nth(i).isVisible().catch(() => false)) {
        return { ok: true, inDom, visibleCount: 1 };
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, inDom, visibleCount: 0 };
}

/* Two failures look identical to a user and are NOT the same thing:
     nothing matched at all       -> the content is genuinely absent
     matched, but none ever shown -> it IS in the page and the page hides it
   "Visible" is Playwright's meaning: in the DOM, non-zero size, not display:none or
   visibility:hidden. Content BELOW THE FOLD counts as visible — no scrolling needed —
   so never say "off-screen".
   Needing a SPECIFIC occurrence (the 6th, or the one inside a heading) is a different
   assertion; use "Check: element is visible" with a CSS selector such as
   h3:has-text("Mission"), or upload a script, where the whole Playwright API is
   available. Scoped text matching in the step builder is tracked separately. */
function describeNoVisible(what, inDom) {
  if (inDom > 0) {
    return `Found ${what} ${inDom} time${inDom === 1 ? "" : "s"} in the page, but ` +
           `${inDom === 1 ? "it never became" : "none of them became"} visible within the ` +
           `step timeout — the page hides ${inDom === 1 ? "it" : "them"} (a hover-only menu, ` +
           `a closed tab, or display:none).`;
  }
  return `${what} is not in the page at all — nothing matched within the step timeout.`;
}

function stepLabel(s) {
  return s.action + (s.selector ? ` ${s.selector}` : "") + (s.value && s.action !== "fill" ? ` "${String(s.value).slice(0, 40)}"` : "");
}

/** One user runs the whole flow `loops` times. Returns flow results. */
async function runUser(browser, test, userIdx, screenshots) {
  const steps = test.browser_steps;
  const flows = [];
  for (let loop = 0; loop < test.loops; loop++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = context.pages()[0] || (await context.newPage());
    const flow = { user: userIdx + 1, loop: loop + 1, steps: [], ok: true, ms: 0 };
    const flowStart = Date.now();
    try {
      // Implicit first step: open the test's start URL.
      await page.goto(test.target_url, { timeout: STEP_TIMEOUT_MS, waitUntil: "domcontentloaded" });
      for (const [i, step] of steps.entries()) {
        const t0 = Date.now();
        try {
          await execStep(page, step);
          flow.steps.push({ i, ok: true, ms: Date.now() - t0 });
        } catch (e) {
          flow.steps.push({ i, ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 300) });
          flow.ok = false;
          if (screenshots.length < MAX_SCREENSHOTS) {
            const shot = await page.screenshot({ type: "jpeg", quality: 40 }).catch(() => null);
            if (shot)
              screenshots.push({
                user: userIdx + 1,
                loop: loop + 1,
                step: i + 1,
                label: stepLabel(step),
                error: String(e.message).slice(0, 300),
                jpeg_base64: shot.toString("base64"),
              });
          }
          break; // a failed step ends this user's flow
        }
      }
    } catch (e) {
      flow.ok = false;
      flow.steps.push({ i: -1, ok: false, ms: 0, error: `Could not open ${test.target_url}: ${String(e.message).slice(0, 200)}` });
    }
    flow.ms = Date.now() - flowStart;
    flows.push(flow);
    await context.close().catch(() => {});
  }
  return flows;
}

function aggregate(test, allFlows) {
  const steps = test.browser_steps.map((s, i) => {
    const results = allFlows.flatMap((f) => f.steps.filter((r) => r.i === i));
    const ok = results.filter((r) => r.ok);
    return {
      step: i + 1,
      label: stepLabel(s),
      runs: results.length,
      passed: ok.length,
      failed: results.length - ok.length,
      avg_ms: ok.length ? Math.round(ok.reduce((a, r) => a + r.ms, 0) / ok.length) : null,
      first_error: results.find((r) => !r.ok)?.error || null,
    };
  });
  const passed = allFlows.filter((f) => f.ok).length;
  const durations = allFlows.map((f) => f.ms).sort((a, b) => a - b);
  return {
    test_type: "browser",
    users: test.virtual_users,
    loops: test.loops,
    flows_total: allFlows.length,
    flows_passed: passed,
    pass_rate: allFlows.length ? +((passed / allFlows.length) * 100).toFixed(1) : 0,
    avg_flow_ms: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    max_flow_ms: durations[durations.length - 1] ?? 0,
    steps,
  };
}

async function processRun(run) {
  const t = (await pool.query("SELECT * FROM tests WHERE id=$1", [run.test_id])).rows[0];
  console.log(`[browser] run ${run.id}: ${t.virtual_users} user(s) × ${t.loops} loop(s) on ${t.browser || 'chromium'}, ${t.browser_steps.length} steps → ${t.target_url}`);
  let browser;
  try {
    browser = await launchBrowser(t.browser);
    const screenshots = [];
    const perUser = await Promise.all(
      Array.from({ length: t.virtual_users }, (_, u) => runUser(browser, t, u, screenshots))
    );
    const summary = aggregate(t, perUser.flat());
    const sla = evaluateSla(t.sla, summary);
    if (sla) summary.sla = sla;
    summary.screenshots = screenshots; // capped; jpeg quality 40

    await pool.query(
      /* `analyzing`, NOT `done`. Same bug as worker.js:1279, fixed there on Aug 18
         and MISSED here — the pattern was not grepped across both workers. Marking a
         run done before ai_analysis exists makes the report page stop polling, see a
         terminal status with a null analysis, and print "The analysis did not run"
         about an analysis that is running. The real transition to done is below,
         after the analysis has been stored. */
      "UPDATE runs SET status='analyzing', finished_at=now(), summary=$1, sla_passed=$2, profile=$3 WHERE id=$4",
      [JSON.stringify(summary), sla ? sla.passed : null, JSON.stringify(loadProfile(t)), run.id]
    );

    // AI analysis with history — screenshots stripped so no page imagery
    // leaves the platform (not to Claude, not into email).
    try {
      const { screenshots: _omit, ...forAi } = summary;
      const history = await getRunHistory(t.id, run.id, 5, run.compare_to);
      const analysis = await analyzeRun({ test: t, summary: forAi, timeseries: [], history });
      await pool.query("UPDATE runs SET ai_analysis=$1 WHERE id=$2", [JSON.stringify(analysis), run.id]);
      await sendRunEmail({ test: t, run, summary: forAi, analysis, history });
    } catch (e) {
      console.warn(`[browser] analysis/email skipped: ${e.message}`);
    }
    // Only NOW is the run terminal. Outside the try above on purpose: if the analysis
    // or the email throws, the run must still reach `done` rather than sticking in
    // `analyzing` forever — a stuck status is worse than a missing analysis.
    await pool.query("UPDATE runs SET status='done' WHERE id=$1", [run.id]);
    await notifyRunResult(pool, t, { ...run, status: "done" }, summary).catch(() => {});
    console.log(`[browser] run ${run.id} done: ${summary.flows_passed}/${summary.flows_total} flows passed`);
  } catch (e) {
    console.error(`[browser] run ${run.id} failed:`, e.message);
    await pool.query("UPDATE runs SET status='failed', finished_at=now(), error=$1 WHERE id=$2", [
      e.message.slice(0, 1000),
      run.id,
    ]);
    await notifyRunResult(pool, t, { ...run, status: "failed", error: e.message }, null).catch(() => {});
  } finally {
    await browser?.close().catch(() => {});
  }
}

/* This worker never announced itself. Migration 019 gave `workers` a `kind`
   column defaulting to 'http' — the second kind was anticipated and never wired,
   so nothing anywhere could answer "is a browser worker alive?". The API queued
   five PDF exports against a worker that had crashed on startup and told the user
   "a real browser is printing your report" for an hour.

   Beaten from INSIDE the loop rather than a setInterval: worker.js crash-looped on
   boot because its heartbeat timer was declared above the const it depended on, and
   node --check passes a temporal-dead-zone error. Here there is nothing to get out
   of order — loop() runs long after every declaration in the file. */
const WORKER_ID = os.hostname();

async function loop() {
  console.log("[browser] Loadstar browser worker started (Playwright/Chromium), polling for runs…");
  for (;;) {
    try {
      // A missed beat must never kill the worker; worst case the API stops
      // offering browser work, which is visible and recoverable.
      await beatWorker(WORKER_ID, "browser").catch((e) =>
        console.warn(`[browser] heartbeat failed: ${e.message}`));
      const run = await claimNextRun();
      if (run) { await processRun(run); continue; }
      const exp = await claimNextExport();
      if (exp) { await processExport(exp); continue; }
      await new Promise((r) => setTimeout(r, POLL_MS));
    } catch (e) {
      console.error("[browser] loop error:", e.message);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

/* ————— Report exports: PDF + email bundle ————— */

async function claimNextExport() {
  const q = await pool.query(`
    UPDATE exports SET status='working'
    WHERE id = (SELECT id FROM exports WHERE status='queued'
                ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING *`);
  return q.rows[0] || null;
}

async function loadFullRun(runId) {
  const q = await pool.query(
    `SELECT runs.*, to_jsonb(tests.*) AS test FROM runs
     JOIN tests ON tests.id = runs.test_id WHERE runs.id=$1`,
    [runId]
  );
  const run = q.rows[0];
  if (!run) return null;
  const history = await getRunHistory(run.test_id, run.id, 5, run.compare_to);
  return { run, test: run.test, summary: run.summary, timeseries: run.timeseries || [], analysis: run.ai_analysis, history };
}

async function htmlToPdf(html) {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    return await page.pdf({ format: "A4", printBackground: true, margin: { top: "12mm", bottom: "12mm", left: "8mm", right: "8mm" } });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function processExport(exp) {
  try {
    const full = await loadFullRun(exp.run_id);
    if (!full || full.run.status !== "done") throw new Error("Run not found or not finished.");
    const short = exp.run_id.slice(0, 8);
    const html = renderReportHtml(full);

    if (exp.format === "pdf") {
      const pdf = await htmlToPdf(html);
      await pool.query("UPDATE exports SET status='done', file=$1, filename=$2 WHERE id=$3", [
        pdf, `loadstar-report-${short}.pdf`, exp.id,
      ]);
      console.log(`[browser] pdf export ${exp.id} done (${Math.round(pdf.length / 1024)} KB)`);
      return;
    }

    if (exp.format === "email_bundle") {
      const to = exp.detail?.to;
      const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
      if (!SMTP_HOST) throw new Error("SMTP is not configured in .env — cannot send email.");
      const [pdf, pptx] = await Promise.all([htmlToPdf(html), buildPptx(full)]);
      const t = nodemailer.createTransport({
        host: SMTP_HOST, port: Number(SMTP_PORT || 587), secure: Number(SMTP_PORT) === 465,
        auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
      });
      const verdict = (full.analysis?.verdict || "done").toUpperCase();
      await t.sendMail({
        from: SMTP_FROM || SMTP_USER,
        to,
        subject: `[Loadstar] ${verdict} — ${full.test.name} (full report attached)`,
        html,
        attachments: [
          { filename: `loadstar-report-${short}.html`, content: html },
          { filename: `loadstar-report-${short}.pdf`, content: pdf },
          { filename: `loadstar-report-${short}.pptx`, content: pptx },
        ],
      });
      await pool.query("UPDATE exports SET status='done', filename=$1 WHERE id=$2", [`sent to ${to}`, exp.id]);
      console.log(`[browser] email bundle ${exp.id} sent to ${to}`);
      return;
    }

    throw new Error(`Unknown export format: ${exp.format}`);
  } catch (e) {
    console.error(`[browser] export ${exp.id} failed:`, e.message);
    await pool.query("UPDATE exports SET status='failed', error=$1 WHERE id=$2", [e.message.slice(0, 500), exp.id]);
  }
}
loop();
