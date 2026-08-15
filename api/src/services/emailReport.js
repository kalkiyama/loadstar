import { deriveVerdict } from "./reportHtml.js";
import { fmtMs } from "../db.js";
/**
 * Post-run email reports: AI verdict + trend vs past runs, pros/cons, metrics.
 *
 * Configure any SMTP account in .env (Gmail app password, SendGrid, Mailgun…).
 * Recipient = the test's notify_email, falling back to REPORT_EMAIL_TO.
 * Fail-soft: missing SMTP config or recipient simply skips the email.
 */
import nodemailer from "nodemailer";
import { pool } from "../db.js";

let transport = null;
function getTransport() {
  if (transport) return transport;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST) return null;
  transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT) === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  return transport;
}

/** Last N finished runs of the same test (excluding the current one), compact. */
/**
 * Run history for comparison: the BASELINE (if one is marked) plus the most
 * recent runs. The baseline is always included no matter how old it is.
 *
 * Why: with only "the last N runs", a test whose last five runs were all
 * degraded compares broken to broken and the AI reports "stable". Keeping the
 * baseline in the set means the AI can see current=bad, recent=bad, baseline=good
 * and say what is actually true: we regressed, and have been stable while broken.
 *
 * compareToId (optional) pins a specific run to compare against — e.g. CI wanting
 * "this PR build vs that main build" without touching the test's baseline.
 */
/* History x endpoints multiplies: 5 runs x 200 endpoints = 1000 rows into the AI
   prompt. Cap it. The rows arrive sorted slowest-p95 first, so the top N are the
   ones that matter — and every errorer is already near the top of a bad run. */
const HISTORY_ENDPOINT_CAP = 10;

export async function getRunHistory(testId, excludeRunId, limit = 5, compareToId = null) {
  const q = await pool.query(
    `SELECT id, status, finished_at, summary, profile, is_baseline FROM runs
     WHERE test_id=$1 AND id<>$2 AND status IN ('done','failed') AND shard_of IS NULL
       AND (
         is_baseline
         OR id = $4
         OR id IN (
           SELECT id FROM runs
           WHERE test_id=$1 AND id<>$2 AND status IN ('done','failed') AND shard_of IS NULL
           ORDER BY created_at DESC LIMIT $3
         )
       )
     ORDER BY is_baseline DESC, created_at DESC`,
    [testId, excludeRunId, limit, compareToId]
  );
  return q.rows.map((r) => {
    const s = r.summary || {};
    const base = {
      run_id: r.id,
      when: r.finished_at,
      status: r.status,
      is_baseline: r.is_baseline === true,
      pinned_comparison: compareToId != null && r.id === compareToId,
      load_profile: r.profile || "unknown (run predates profile capture)",
    };
    return s.test_type === "browser"
      ? { ...base, pass_rate: s.pass_rate, avg_flow_ms: s.avg_flow_ms, flows: `${s.flows_passed}/${s.flows_total}` }
      : {
          ...base,
          p95_ms: s.p95_ms,
          error_rate: s.error_rate,
          throughput_rps: s.throughput_rps,
          /* The DB row already contained per_endpoint. Three scalars were being
             cherry-picked and the rest thrown away BEFORE the AI ever saw it —
             which is precisely why claudeAnalyst could never say "/checkout
             regressed 40%" and could call a real regression "stable".

             Capped: history x endpoints multiplies fast and would blow the prompt.
             Keep every endpoint that ERRORED (never hide a broken route) plus the
             slowest by p95 — the rows are already sorted slowest-first. */
          per_endpoint: Array.isArray(s.per_endpoint)
            ? s.per_endpoint.slice(0, HISTORY_ENDPOINT_CAP).map((e) => ({
                name: e.name,
                requests: e.requests,
                errors: e.errors,
                error_rate: e.error_rate,
                p95_ms: e.p95_ms,
                p99_ms: e.p99_ms,
                avg_ms: e.avg_ms,
                status_codes: e.status_codes,
              }))
            : undefined,
        };
  });
}

const escHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const COLORS = { pass: "#14A06B", degraded: "#E8960C", fail: "#FF4F30" };
const TREND = { improving: "▲ Improving", regressing: "▼ Regressing", stable: "► Stable", first_run: "● First run" };

/* One plain-text status line for the email. Deliberately NOT the colour-coded
   strip from the web report: email clients strip CSS, and a row in the metrics
   table that already renders everywhere beats a section that renders nowhere.
   Mirrors worker/statuscodes.mjs (unit-tested there). */
function statusText(summary) {
  const rows = (summary && summary.per_endpoint) || [];
  const counts = new Map();
  let coded = 0;
  for (const r of rows) {
    const codes = (r && r.status_codes) || {};
    for (const code in codes) {
      const c = Number(code);
      if (!isFinite(c) || c <= 0) continue;
      const k = Number(codes[code]) || 0;
      counts.set(c, (counts.get(c) || 0) + k);
      coded += k;
    }
  }
  if (!counts.size) return "";
  const total = Number(summary && summary.total_requests) || 0;
  const list = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([code, count]) => [String(code), count]);
  /* Silence is not a 200: a request that got no response at all carries no
     status code, and must not vanish from a summary someone reads instead of
     opening the report. */
  const missing = total - coded;
  if (missing > 0) list.push(["no response", missing]);
  const showPct = list.length > 1 && total > 0;
  return list
    .map(([label, n]) => label + " \u00d7 " + n.toLocaleString() +
      (showPct ? " (" + ((n / total) * 100).toFixed(1) + "%)" : ""))
    .join("  \u00b7  ");
}

function metricRows(summary) {
  const rows =
    summary?.test_type === "browser"
      ? [["Flows passed", `${summary.flows_passed}/${summary.flows_total}`], ["Pass rate", summary.pass_rate + "%"], ["Avg flow time", summary.avg_flow_ms + " ms"], ["Slowest flow", summary.max_flow_ms + " ms"]]
      : [["Requests", summary?.total_requests], ["Throughput", summary?.throughput_rps + " req/s"], ["Error rate", summary?.error_rate + "%"], ["p95", fmtMs(summary?.p95_ms)],
         ...(statusText(summary) ? [["Status codes", statusText(summary)]] : [])];
  return rows
    .map(
      ([k, v]) => `<tr>
        <td style="padding:6px 14px;color:#5A6B7A;font-size:12px;border-bottom:1px solid #E2E8ED">${k}</td>
        <td style="padding:6px 14px;font-family:monospace;font-size:14px;border-bottom:1px solid #E2E8ED">${escHtml(v)}</td></tr>`
    )
    .join("");
}

function bulletList(title, items, color = "#182430") {
  if (!items?.length) return "";
  return `<h3 style="font-family:Helvetica,Arial,sans-serif;font-size:14px;margin:18px 0 6px;color:${color}">${title}</h3>
    <ul style="margin:0;padding-left:20px">${items.map((i) => `<li style="margin:4px 0;font-size:14px;line-height:1.5">${escHtml(i)}</li>`).join("")}</ul>`;
}



export function renderRunEmail({ test, run, summary, analysis, history }) {
  const verdict = deriveVerdict(run, summary, analysis);
  const color = COLORS[verdict] || "#182430";
  const base = process.env.APP_BASE_URL || "http://localhost:8080";
  const histLine = history?.length
    ? `Compared against your last ${history.length} run${history.length > 1 ? "s" : ""} of this test.`
    : "First recorded run of this test — future emails will show the trend.";
  return `
  <div style="font-family:Helvetica,Arial,sans-serif;color:#182430;max-width:600px;margin:0 auto;background:#F6F8FA;padding:24px">
    <div style="background:#182430;border-radius:10px 10px 0 0;padding:14px 22px;border-bottom:2px solid #1E5EFF">
      <span style="color:#fff;font-weight:bold;font-size:16px">Loadstar</span>
      <span style="color:#9FB4C6;font-size:10px;letter-spacing:2px;margin-left:8px">TEST REPORT</span>
    </div>
    <div style="background:#fff;border:1px solid #C9D3DB;border-top:none;border-radius:0 0 10px 10px;padding:24px 22px">
      <h2 style="margin:0 0 4px;font-size:19px">${escHtml(test.name)}</h2>
      <p style="margin:0 0 14px;color:#5A6B7A;font-size:12px;font-family:monospace">
        ${summary?.test_type === "browser" ? "browser test" : (test.mode || "load") + " test"} · ${escHtml(new URL(test.target_url).hostname)}${
          (() => {
            let secs = summary?.wall_seconds;
            if (secs == null && run.started_at && run.finished_at)
              secs = Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000);
            return secs != null ? ` · ran ${secs >= 60 ? Math.floor(secs / 60) + "m " + (secs % 60) + "s" : secs + "s"}` : "";
          })()
        } · ${new Date().toLocaleString()}</p>
      <div style="display:inline-block;padding:4px 14px;border-radius:999px;background:${color}1A;color:${color};font-weight:bold;font-size:13px;letter-spacing:1px">
        ${verdict.toUpperCase()}</div>
      <span style="margin-left:10px;font-size:13px;color:#5A6B7A">${TREND[analysis?.trend] || ""}</span>
      <p style="font-size:15px;line-height:1.5;margin:14px 0">${escHtml(analysis?.headline || "Run complete.")}</p>
      <p style="font-size:12px;color:#5A6B7A;margin:0 0 14px">${histLine}</p>
      <table style="border-collapse:collapse;width:100%;border:1px solid #E2E8ED;border-radius:8px">${metricRows(summary)}</table>
      ${bulletList("✔ What went well", analysis?.pros, "#14A06B")}
      ${bulletList("✘ Concerns", analysis?.cons, "#FF4F30")}
      ${bulletList("Recommendations", analysis?.recommendations)}
      <a href="${base}" style="display:inline-block;margin-top:20px;background:#1E5EFF;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:bold">Open the full report</a>
      <p style="margin-top:22px;font-size:11px;color:#5A6B7A;font-family:monospace">Loadstar · open-source performance &amp; browser testing · analysis by Claude</p>
    </div>
  </div>`;
}

export async function sendRunEmail({ test, run, summary, analysis, history }) {
  const to = test.notify_email || process.env.REPORT_EMAIL_TO;
  const t = getTransport();
  if (!to || !t) return { skipped: true };
  const verdict = (analysis?.verdict || run.status).toUpperCase();
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: `[Loadstar] ${verdict} — ${test.name}`,
      html: renderRunEmail({ test, run, summary, analysis, history }),
    });
    console.log(`[email] report sent to ${to} for run ${run.id}`);
    return { sent: true };
  } catch (e) {
    console.warn(`[email] send failed: ${e.message}`);
    return { error: e.message };
  }
}
