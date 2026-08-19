import { fmtMs } from "../db.js";
/**
 * Standalone HTML report — one self-contained file (inline styles, inline SVG
 * chart, no external assets) so it opens anywhere, prints cleanly, and is the
 * source for PDF rendering. Includes history comparison and AI analysis.
 */
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const C = { ink: "#182430", ink2: "#5A6B7A", grid: "#E2E8ED", line: "#C9D3DB", blue: "#1E5EFF", coral: "#FF4F30", green: "#14A06B", amber: "#E8960C", paper: "#F6F8FA" };
const VERDICT_COLOR = { pass: C.green, degraded: C.amber, fail: C.coral, cancelled: C.ink2 };
const TREND = { improving: "▲ Improving", regressing: "▼ Regressing", stable: "► Stable", first_run: "● First run" };

function svgChart(ts) {
  if (!ts?.length) return "";
  const W = 700, H = 220, pad = { l: 46, r: 12, t: 14, b: 24 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const maxMs = Math.max(...ts.map((p) => p.ms), 1);
  const maxRps = Math.max(...ts.map((p) => p.rps), 1);
  const maxT = Math.max(...ts.map((p) => p.t), 1);
  const x = (t) => pad.l + (t / maxT) * iw;
  const yMs = (v) => pad.t + ih - (v / maxMs) * ih;
  const yRps = (v) => pad.t + ih - (v / maxRps) * ih;
  const path = (yFn, key) => ts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${yFn(p[key]).toFixed(1)}`).join(" ");
  const gridLines = [0, 1, 2, 3, 4]
    .map((i) => {
      const y = pad.t + (ih / 4) * i;
      return `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="${C.grid}"/>
        <text x="4" y="${y + 3}" font-size="9" font-family="monospace" fill="${C.ink2}">${Math.round(maxMs * (1 - i / 4))}ms</text>`;
    })
    .join("");
  const errDots = ts.filter((p) => p.err > 0)
    .map((p) => `<circle cx="${x(p.t).toFixed(1)}" cy="${yMs(p.ms).toFixed(1)}" r="3" fill="${C.coral}"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">
    ${gridLines}
    <path d="${path(yRps, "rps")}" stroke="${C.green}" stroke-width="1.5" fill="none"/>
    <path d="${path(yMs, "ms")}" stroke="${C.blue}" stroke-width="2" fill="none"/>
    ${errDots}
    <text x="${pad.l}" y="${H - 6}" font-size="9" font-family="monospace" fill="${C.ink2}">0s</text>
    <text x="${W - 40}" y="${H - 6}" font-size="9" font-family="monospace" fill="${C.ink2}">${maxT}s</text>
  </svg>
  <p style="font-family:monospace;font-size:11px;color:${C.ink2}">
    <span style="color:${C.blue}">—</span> response time (ms) &nbsp;
    <span style="color:${C.green}">—</span> throughput (req/s) &nbsp;
    <span style="color:${C.coral}">●</span> errors</p>`;
}

const cell = (v, mono = true) =>
  `<td style="padding:8px 12px;border-bottom:1px solid ${C.grid};${mono ? "font-family:monospace;font-size:13px" : "font-size:13px"}">${esc(v ?? "—")}</td>`;
const th = (v) =>
  `<th style="padding:8px 12px;text-align:left;font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:${C.ink2};background:${C.paper};border-bottom:1px solid ${C.grid}">${esc(v)}</th>`;

/* One row per endpoint, slowest p95 first — because the entire point is that a slow
   or broken endpoint must not be able to hide inside a healthy blended average.
   Rendered only when there is more than one endpoint: a single-endpoint test already
   has this information in the aggregate, and a one-row table is noise. */
/* Run-level HTTP status distribution. Mirrors worker/statuscodes.mjs (unit-tested
   there); exports render everything, so no collapsing here. */
function statusStrip(s) {
  const rows = (s && s.per_endpoint) || [];
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
  const total = Number(s && s.total_requests) || 0;
  const list = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([code, count]) => ({ code, count }));
  /* Silence is not a 200: requests that got no response at all are named. */
  const missing = total - coded;
  if (missing > 0) list.push({ code: 0, count: missing });
  const showPct = list.length > 1 && total > 0;
  const colorOf = (c) => (c === 0 || c >= 500) ? C.coral : c >= 400 ? "#d98324" : c >= 300 ? C.ink2 : C.ink;
  const chips = list.map((x) => {
    const label = x.code === 0 ? "no response" : String(x.code);
    const pct = showPct ? ` (${((x.count / total) * 100).toFixed(1)}%)` : "";
    return `<span style="display:inline-block;margin:0 18px 4px 0;white-space:nowrap;color:${colorOf(x.code)};font-size:13px">` +
      `<b>${esc(label)}</b> &#215; ${x.count.toLocaleString()}${esc(pct)}</span>`;
  }).join("");
  return `<h2 style="font-size:15px;margin:24px 0 8px">HTTP status codes</h2>` +
    `<p style="font-size:12px;color:${C.ink2};margin:0 0 10px">What the target actually answered, across every request in this run.</p>` +
    `<div style="line-height:1.9">${chips}</div>`;
}

function endpointTable(s) {
  const rows = s && s.per_endpoint;
  if (!Array.isArray(rows) || rows.length < 2) return "";

  const head = ["Endpoint", "Requests", "Errors", "Error rate", "Avg", "p95", "p99"]
    .map((h) => th(h))
    .join("");

  const body = rows
    .map((r) => {
      const bad = (r.errors || 0) > 0;
      // A sub-sample is one hop of a redirect chain, not a separate endpoint.
      const subTag = r.sub_sample ? (r.redirect_hop ? " \u21b3 redirect hop" : " \u21b3 sub-request") : "";
      const nameCell =
        `<td style="padding:8px 12px;border-bottom:1px solid ${C.grid};font-size:13px;` +
        (r.sub_sample ? "padding-left:26px;opacity:.8;" : "") +
        (bad ? `color:${C.coral};font-weight:600` : "") + `">${esc(r.name)}` +
        (subTag ? `<span style="color:${C.ink2};font-size:11px">${esc(subTag)}</span>` : "") + `</td>`;
      const errCell =
        `<td style="padding:8px 12px;border-bottom:1px solid ${C.grid};font-family:monospace;font-size:13px;` +
        (bad ? `color:${C.coral};font-weight:600` : "") + `">${esc(String(r.errors))}</td>`;
      return `<tr>${nameCell}${cell(r.requests)}${errCell}${cell(r.error_rate + "%")}` +
        `${cell(fmtMs(r.avg_ms))}${cell(fmtMs(r.p95_ms))}${cell(fmtMs(r.p99_ms))}</tr>`;
    })
    .join("");

  return `<h2 style="font-size:15px;margin:24px 0 8px">Per-endpoint breakdown</h2>` +
    `<p style="font-size:12px;color:${C.ink2};margin:0 0 10px">Slowest first. The blended ` +
    `numbers above can look healthy while one endpoint is not — this is where to look.</p>` +
    `<table style="border-collapse:collapse;width:100%"><tr>${head}</tr>${body}</table>`;
}

function metricsTable(s) {
  const rows =
    s?.test_type === "browser"
      ? [["Flows passed", `${s.flows_passed}/${s.flows_total}`], ["Pass rate", s.pass_rate + "%"], ["Avg flow time", s.avg_flow_ms + " ms"], ["Slowest flow", s.max_flow_ms + " ms"]]
      : [["Requests", s?.total_requests], ["Throughput", s?.throughput_rps + " req/s"], ["Error rate", s?.error_rate + "%"], ...(s?.generator ? [["Generator load", s.generator.peak_load_ratio + "\u00d7 on " + s.generator.cores + " cores" + (s.generator.saturated ? " \u26a0 saturated" : "")]] : []), ...((s?.assertion_total ?? 0) > 0 ? [["Assertion failures", s.assertion_failures + " / " + s.assertion_total]] : []), ["Avg", fmtMs(s?.avg_ms)], ["p50", fmtMs(s?.p50_ms)], ["p90", fmtMs(s?.p90_ms)], ["p95", fmtMs(s?.p95_ms)], ["p99", fmtMs(s?.p99_ms)]];
  return `<table style="border-collapse:collapse;width:100%">${rows
    .map(([k, v]) => `<tr>${cell(k, false)}${cell(v)}</tr>`).join("")}</table>`;
}

function historyTable(summary, history) {
  if (!history?.length) return `<p style="color:${C.ink2};font-size:13px">First recorded run — no history yet.</p>`;
  const isBrowser = summary?.test_type === "browser";
  const cols = isBrowser ? ["When", "Status", "Pass rate", "Avg flow"] : ["When", "Status", "p95", "Error rate", "Throughput"];
  // Mark the baseline row so the comparison is auditable: when the AI says
  // "regressed against baseline", the reader can see which run that was.
  const when = (h) => {
    const t = new Date(h.when).toLocaleString();
    if (h.is_baseline) return "★ " + t + " (baseline)";
    if (h.pinned_comparison) return "→ " + t + " (compared to)";
    return t;
  };
  const row = (h, label) =>
    `<tr${h.is_baseline ? ` style="background:#FFF8E1"` : ""}>${cell(label || when(h), false)}${cell(h.status)}${
      isBrowser ? cell((h.pass_rate ?? "—") + "%") + cell((h.avg_flow_ms ?? "—") + " ms")
      : cell((h.p95_ms ?? "—") + " ms") + cell((h.error_rate ?? "—") + "%") + cell((h.throughput_rps ?? "—") + " rps")}</tr>`;
  const current = isBrowser
    ? { when: null, status: "this run", pass_rate: summary.pass_rate, avg_flow_ms: summary.avg_flow_ms }
    : { when: null, status: "this run", p95_ms: summary.p95_ms, error_rate: summary.error_rate, throughput_rps: summary.throughput_rps };
  return `<table style="border-collapse:collapse;width:100%;border:1px solid ${C.grid}">
    <tr>${cols.map(th).join("")}</tr>
    <tr style="background:#EDF2FF">${row(current, "This run").slice(4)}
    ${history.map((h) => row(h)).join("")}</table>`;
}

function stepsTable(s) {
  if (!s?.steps?.length) return "";
  return `<h2 style="font-size:17px;margin:26px 0 8px">Steps</h2>
  <table style="border-collapse:collapse;width:100%;border:1px solid ${C.grid}">
    <tr>${["#", "Action", "Passed", "Avg time", "First error"].map(th).join("")}</tr>
    ${s.steps.map((st) =>
        `<tr>${cell(st.step)}${cell(st.label)}<td style="padding:8px 12px;border-bottom:1px solid ${C.grid};font-weight:bold;color:${st.failed ? C.coral : C.green}">${st.passed}/${st.runs}</td>${cell(fmtMs(st.avg_ms))}${cell(st.first_error || "")}</tr>`
      ).join("")}</table>`;
}

const bullets = (title, items, color = C.ink) =>
  items?.length
    ? `<h3 style="font-size:14px;margin:18px 0 6px;color:${color}">${title}</h3>
       <ul style="margin:0;padding-left:20px">${items.map((i) => `<li style="margin:4px 0;font-size:14px;line-height:1.5">${esc(i)}</li>`).join("")}</ul>`
    : "";


/* When the AI analysis did not run, SAY SO. This is the artifact people send to
   their boss, and it used to render "Run complete." with four empty sections —
   which reads as "the AI looked and had nothing to say" rather than "the AI never
   ran". Confidently silent about the failure of the headline feature.

   The verdict itself is still trustworthy: deriveVerdict() falls back to honest
   metrics. So this is a notice, not an alarm — the numbers are fine, the analysis
   is missing, and the reader deserves to know which. */
function aiUnavailableNotice(analysis) {
  if (analysis && analysis.verdict) return "";           // analysis is fine
  const reason =
    analysis && analysis.error ? analysis.error
      : analysis && analysis.reason ? analysis.reason
      : "The analysis did not run. Check ANTHROPIC_API_KEY and the worker logs.";
  return `<div style="background:#FFF4E5;border:1px solid ${C.amber};border-radius:8px;padding:12px 14px;margin:0 0 16px">
      <b style="color:${C.amber}">AI analysis unavailable</b>
      <div style="font-size:13px;color:${C.ink2};margin-top:4px">${esc(reason)}
      <br>The metrics and the verdict below are unaffected \u2014 they are computed from the run itself.</div>
    </div>`;
}

/** Honest verdict from metrics when AI analysis is absent. */
export function deriveVerdict(run, summary, analysis) {
  if (analysis?.verdict) return analysis.verdict;
  if (run.status === "failed") return "fail";
  // A stopped run is an INCOMPLETE measurement, not a pass. Without this it falls
  // through to the metric checks and renders a green PASS on partial data.
  if (run.status === "cancelled") return "cancelled";
  if (summary?.sla && summary.sla.passed === false) return "fail";
  if (summary?.test_type === "browser")
    return (summary.pass_rate ?? 100) >= 100 ? "pass" : "fail";
  if ((summary?.error_rate ?? 0) > 0) return "fail";
  if ((summary?.assertion_failures ?? 0) > 0) return "fail";
  return "pass";
}

export function renderReportHtml({ test, run, summary, timeseries, analysis, history }) {
  const verdict = deriveVerdict(run, summary, analysis);
  const vc = VERDICT_COLOR[verdict] || C.ink;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Loadstar report — ${esc(test.name)}</title>
<style>@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }</style>
</head>
<body style="margin:0;background:${C.paper};font-family:Helvetica,Arial,sans-serif;color:${C.ink}">
<div style="max-width:760px;margin:0 auto;padding:28px 20px 60px">
  <div style="background:${C.ink};border-radius:10px 10px 0 0;padding:14px 24px;border-bottom:2px solid ${C.blue}">
    <span style="color:#fff;font-weight:bold;font-size:17px">Loadstar</span>
    <span style="color:#9FB4C6;font-size:10px;letter-spacing:2px;margin-left:8px">TEST REPORT</span>
  </div>
  <div style="background:#fff;border:1px solid ${C.line};border-top:none;border-radius:0 0 10px 10px;padding:28px 26px">
    <h1 style="margin:0 0 4px;font-size:24px;letter-spacing:-.01em">${esc(test.name)}</h1>
    <p style="margin:0 0 16px;color:${C.ink2};font-size:12px;font-family:monospace">
      ${summary?.test_type === "browser" ? `browser test · ${test.browser || "chromium"} · ${test.virtual_users} user(s) × ${test.loops} loop(s)` : `${esc(test.mode || "load")} test · ${esc(test.engine || "jmeter")} · ${test.virtual_users} VU · ${test.duration_secs}s${summary?.distributed ? ` · ${summary.shards} generators` : ""}`}
      · ${esc(new URL(test.target_url).hostname)}${
        (() => {
          let secs = summary?.wall_seconds;
          if (secs == null && run.started_at && run.finished_at)
            secs = Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000);
          return secs != null ? ` · ran ${secs >= 60 ? Math.floor(secs / 60) + "m " + (secs % 60) + "s" : secs + "s"}` : "";
        })()
      } · generated ${new Date().toLocaleString()}</p>
    <span style="display:inline-block;padding:5px 16px;border-radius:999px;background:${vc}1A;color:${vc};font-weight:bold;font-size:14px;letter-spacing:1px">${verdict.toUpperCase()}</span>
    <span style="margin-left:10px;font-size:13px;color:${C.ink2};font-family:monospace">${TREND[analysis?.trend] || ""}</span>
    <p style="font-size:16px;line-height:1.55;margin:16px 0 22px">${esc(analysis?.headline || (analysis?.error ? "" : "Run complete."))}</p>

    ${aiUnavailableNotice(analysis)}

    ${summary?.generator?.saturated ? `<div style="background:#FFF4E5;border:1px solid #E8960C;border-radius:8px;padding:12px 14px;margin:0 0 16px">
      <b style="color:#E8960C">&#9888; The load generator was saturated.</b>
      <div style="font-size:13px;color:#5A6B7A;margin-top:4px">
        The generator machine ran at <b>${summary.generator.peak_load_ratio}&times;</b> its ${summary.generator.cores}-core capacity during this test.
        When a generator is starved of CPU, requests queue in the load tool rather than at the target: latency inflates and throughput plateaus,
        which looks exactly like the target struggling. <b>These results may reflect generator limits, not target capacity.</b>
        Reduce virtual users, or run generators on separate machines.
      </div>
    </div>` : ""}
    <h2 style="font-size:17px;margin:0 0 8px">Results</h2>
    ${metricsTable(summary)}
    ${timeseries?.length ? `<h2 style="font-size:17px;margin:26px 0 8px">Response time over the run</h2>${svgChart(timeseries)}` : ""}
    ${stepsTable(summary)}

    <h2 style="font-size:17px;margin:26px 0 8px">Comparison with past runs</h2>
    ${historyTable(summary, history)}

    ${bullets("✔ What went well", analysis?.pros, C.green)}
    ${bullets("✘ Concerns", analysis?.cons, C.coral)}
    ${bullets("Findings", analysis?.findings)}
    ${bullets("Recommendations", analysis?.recommendations)}
    ${bullets("Suspected causes", analysis?.suspected_causes)}
    ${statusStrip(summary)}
    ${endpointTable(summary)}

    <p style="margin-top:30px;font-size:11px;color:${C.ink2};font-family:monospace">
      Loadstar · open-source performance &amp; browser testing${analysis?.verdict ? " · AI analysis by Claude" : ""} · run ${esc(run.id)}</p>
  </div>
</div>
</body></html>`;
}
