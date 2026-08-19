import { deriveVerdict } from "./reportHtml.js";
import { fmtMs } from "../db.js";
/**
 * PowerPoint export — a small branded deck: title & verdict, key metrics,
 * a native chart (line for load tests, bar of step times for browser tests),
 * pros/cons, and recommendations with history comparison.
 */
import PptxGenJS from "pptxgenjs";

const INK = "182430", INK2 = "5A6B7A", BLUE = "1E5EFF", CORAL = "FF4F30", GREEN = "14A06B", AMBER = "E8960C", PAPER = "F6F8FA";
const VC = { pass: GREEN, degraded: AMBER, fail: CORAL };



/* Status codes as ONE metrics-table row, not a new table or slide: pptxgenjs
   layout is the fiddliest renderer we have, and a row in a table that already
   works cannot break the deck. Mirrors worker/statuscodes.mjs (unit-tested). */
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
  /* Silence is not a 200. */
  const missing = total - coded;
  if (missing > 0) list.push(["no response", missing]);
  /* No percentages here: the cell is narrow and wrapping looks broken in a deck. */
  return list.map(([label, n]) => label + " \u00d7 " + n.toLocaleString()).join("  ");
}

/* A slide is not a report. The AI writes 40-word recommendations that are right
   at home in the HTML export and unreadable in a 12pt bullet - clamp for the deck
   and point at the full document. */
function clampBullet(t, max = 220) {
  const str = String(t || "");
  return str.length <= max ? str : str.slice(0, max - 1).replace(/\s+\S*$/, "") + "\u2026";
}

export async function buildPptx({ test, run, summary, timeseries, analysis, history }) {
  const p = new PptxGenJS();
  p.layout = "LAYOUT_16x9";
  p.defineSlideMaster({
    title: "LS",
    background: { color: PAPER },
    objects: [
      { rect: { x: 0, y: 0, w: "100%", h: 0.5, fill: { color: INK } } },
      { rect: { x: 0, y: 0.5, w: "100%", h: 0.03, fill: { color: BLUE } } },
      { text: { text: "Loadstar", options: { x: 0.3, y: 0.08, w: 3, h: 0.34, color: "FFFFFF", bold: true, fontSize: 14 } } },
      { text: { text: "TEST REPORT", options: { x: 1.5, y: 0.08, w: 3, h: 0.34, color: "9FB4C6", fontSize: 8, charSpacing: 3 } } },
    ],
  });
  const verdict = deriveVerdict(run, summary, analysis);
  const isBrowser = summary?.test_type === "browser";

  // Slide 1 — title & verdict
  let s = p.addSlide({ masterName: "LS" });
  s.addText(test.name, { x: 0.5, y: 1.0, w: 9, h: 0.9, fontSize: 30, bold: true, color: INK });
  const durSecs = (() => {
    let secs = summary?.wall_seconds;
    if (secs == null && run.started_at && run.finished_at)
      secs = Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000);
    return secs != null ? ` · ran ${secs >= 60 ? Math.floor(secs / 60) + "m " + (secs % 60) + "s" : secs + "s"}` : "";
  })();
  s.addText(
    `${isBrowser ? "Browser test" : (test.mode || "load") + " test"} · ${isBrowser ? (test.browser || "chromium") : (test.engine || "jmeter")} · ${new URL(test.target_url).hostname}${durSecs} · ${new Date().toLocaleDateString()}`,
    { x: 0.5, y: 1.9, w: 9, h: 0.4, fontSize: 13, color: INK2 }
  );
  s.addText(verdict.toUpperCase(), { x: 0.5, y: 2.5, w: 2.4, h: 0.6, fontSize: 20, bold: true, color: "FFFFFF", fill: { color: VC[verdict] || INK }, align: "center" });
  const trend = { improving: "▲ Improving vs past runs", regressing: "▼ Regressing vs past runs", stable: "► Stable vs past runs", first_run: "● First recorded run" }[analysis?.trend];
  if (trend) s.addText(trend, { x: 3.1, y: 2.5, w: 5, h: 0.6, fontSize: 14, color: INK2, valign: "middle" });
  s.addText(analysis?.headline || "Run complete.", { x: 0.5, y: 3.4, w: 9, h: 1.2, fontSize: 15, color: INK, italic: true });

  // Slide 2 — metrics
  s = p.addSlide({ masterName: "LS" });
  s.addText("Results", { x: 0.5, y: 0.8, w: 9, h: 0.5, fontSize: 20, bold: true, color: INK });
  const rows = isBrowser
    ? [["Flows passed", `${summary.flows_passed}/${summary.flows_total}`], ["Pass rate", summary.pass_rate + "%"], ["Avg flow time", summary.avg_flow_ms + " ms"], ["Slowest flow", summary.max_flow_ms + " ms"]]
    : [["Requests", String(summary?.total_requests ?? "—")], ["Throughput", summary?.throughput_rps + " req/s"], ["Error rate", summary?.error_rate + "%"], ["p50 / p90", `${fmtMs(summary?.p50_ms)} / ${fmtMs(summary?.p90_ms)}`], ["p95 / p99", `${fmtMs(summary?.p95_ms)} / ${fmtMs(summary?.p99_ms)}`],
        ...(statusText(summary) ? [["Status codes", statusText(summary)]] : [])];
  s.addTable(
    rows.map(([k, v]) => [
      { text: k, options: { color: INK2, fontSize: 13 } },
      { text: String(v), options: { color: INK, fontSize: 14, bold: true, fontFace: "Courier New" } },
    ]),
    { x: 0.5, y: 1.4, w: 5.4, rowH: 0.45, border: { pt: 0.5, color: "E2E8ED" }, fill: { color: "FFFFFF" } }
  );
  // history mini-table
  if (history?.length) {
    const hHead = isBrowser ? ["When", "Pass rate", "Avg flow"] : ["When", "p95", "Errors"];
    const hRows = history.slice(0, 5).map((h) =>
      isBrowser
        ? [new Date(h.when).toLocaleDateString(), (h.pass_rate ?? "—") + "%", (h.avg_flow_ms ?? "—") + " ms"]
        : [new Date(h.when).toLocaleDateString(), fmtMs(h.p95_ms), (h.error_rate ?? "—") + "%"]
    );
    s.addText("Past runs", { x: 6.3, y: 1.15, w: 3.2, h: 0.3, fontSize: 12, bold: true, color: INK2 });
    s.addTable(
      [hHead.map((t) => ({ text: t, options: { bold: true, fontSize: 10, color: INK2, fill: { color: PAPER } } })),
        ...hRows.map((r) => r.map((c) => ({ text: String(c), options: { fontSize: 10, color: INK } })))],
      { x: 6.3, y: 1.5, w: 3.2, rowH: 0.3, border: { pt: 0.5, color: "E2E8ED" }, fill: { color: "FFFFFF" } }
    );
  }

  // Slide 3 — chart
  s = p.addSlide({ masterName: "LS" });
  if (!isBrowser && timeseries?.length) {
    /* Response time ONLY. ONE axis cannot carry both series honestly: latency runs
       in the hundreds-to-thousands of ms while throughput is single-digit rps, so
       the throughput line rendered as a flat row of zeros - a legend promising a
       series the chart could not show. A deck slide carries one idea; throughput
       is already a headline metric on the Results slide, and the web report and
       HTML export plot both against their own scales. */
    s.addText("Response time over the run", { x: 0.5, y: 0.8, w: 9, h: 0.5, fontSize: 20, bold: true, color: INK });
    const labels = timeseries.map((pt) => String(pt.t));
    s.addChart(p.ChartType.line, [
      { name: "Response time (ms)", labels, values: timeseries.map((pt) => pt.ms) },
    ], { x: 0.5, y: 1.4, w: 9, h: 3.4, chartColors: [BLUE], lineSize: 2, lineSmooth: true, showLegend: true, legendPos: "b", catAxisHidden: false, valAxisLabelFontSize: 9, catAxisLabelFontSize: 8 });
    s.addText(
      "Throughput averaged " + (summary?.throughput_rps ?? "\u2014") + " req/s over this run (see Results).",
      { x: 0.5, y: 4.9, w: 9, h: 0.3, fontSize: 10, color: INK2, italic: true }
    );
  } else if (isBrowser && summary?.steps?.length) {
    s.addText("Average time per step (ms)", { x: 0.5, y: 0.8, w: 9, h: 0.5, fontSize: 20, bold: true, color: INK });
    s.addChart(p.ChartType.bar, [
      { name: "Avg ms", labels: summary.steps.map((st) => `${st.step}. ${st.label.slice(0, 24)}`), values: summary.steps.map((st) => st.avg_ms ?? 0) },
    ], { x: 0.5, y: 1.4, w: 9, h: 3.6, chartColors: [BLUE], barDir: "bar", showLegend: false, valAxisLabelFontSize: 9, catAxisLabelFontSize: 9 });
  }

  // Slide 4 — pros/cons & recommendations
  s = p.addSlide({ masterName: "LS" });
  s.addText("Analysis (by Claude)", { x: 0.5, y: 0.8, w: 9, h: 0.5, fontSize: 20, bold: true, color: INK });
  const list = (title, items, color, x) => {
    s.addText(title, { x, y: 1.4, w: 4.4, h: 0.4, fontSize: 14, bold: true, color });
    s.addText((items?.length ? items : ["—"]).map((t) => ({ text: t, options: { bullet: true, fontSize: 12, color: INK } })), { x, y: 1.8, w: 4.4, h: 2.6, valign: "top" });
  };
  list("✔ What went well", analysis?.pros, GREEN, 0.5);
  list("✘ Concerns", analysis?.cons, CORAL, 5.1);
  /* Recommendations get their OWN slide. A 16:9 slide is 5.63in tall; the old
     layout put this block at y:4.75 with h:1.1, i.e. ending at 5.85in - off the
     bottom before a single bullet wrapped. Sharing a slide with pros/cons cannot
     work when the AI writes four multi-line recommendations. */
  s = p.addSlide({ masterName: "LS" });
  s.addText("Recommendations", { x: 0.5, y: 0.8, w: 9, h: 0.5, fontSize: 20, bold: true, color: INK });
  s.addText(
    (analysis?.recommendations?.length ? analysis.recommendations : ["\u2014"])
      .slice(0, 6)
      .map((t) => ({ text: clampBullet(t), options: { bullet: true, fontSize: 12, color: INK } })),
    { x: 0.5, y: 1.4, w: 9, h: 3.6, valign: "top" }
  );
  s.addText("Full detail in the HTML report.", { x: 0.5, y: 5.05, w: 9, h: 0.3, fontSize: 10, color: INK2, italic: true });

  return await p.write({ outputType: "nodebuffer" });
}
