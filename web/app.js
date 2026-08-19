// Percentiles come from a 1ms-bucket histogram (worker.js): below 1ms is under
// the instrument resolution. "0 ms" would claim zero latency, which is never true.
// NOTE: mirrors fmtMs in api/src/db.js — browser code cannot import server modules.
/* One metric tile. Single definition — this was duplicated in the load and browser
   report renderers, so every metric change (the <1 ms fix, the assertion-failures
   row) had to be made twice. */
const m = (k, v, unit = "", bad = false) => `
  <div class="metric ${bad ? "bad" : ""}"><div class="k">${k}</div>
  <div class="v">${v ?? "—"}<small> ${unit}</small></div></div>`;

/* The export + baseline card. ONE definition — this markup was duplicated in the load
   and browser report renderers, so every addition (the baseline button, the stop button,
   showing it for cancelled runs) had to be made twice, and once the handler was wired in
   only one of them, leaving a dead button. */
function exportCard(run) {
  return `<div class="export-card" id="export-card" ${["done", "cancelled"].includes(run.status) ? "" : "hidden"}>
      <span class="ai-eyebrow">Export results</span>
      <p class="hint" style="margin:6px 0 10px">Choose the format you need — all include the metrics and the history comparison.</p>
      <div class="export-btns">
        <a class="btn" href="/api/runs/${run.id}/export/html" download>Download HTML</a>
        <button class="btn" id="exp-pdf" data-run="${run.id}">Save as PDF</button>
        <a class="btn" href="/api/runs/${run.id}/export/pptx" download>Save as PowerPoint</a>
        <button class="btn" id="exp-email" data-run="${run.id}">Email all formats</button>
        <input id="exp-email-to" placeholder="recipient@company.com (optional if configured)" style="flex:1;min-width:220px" />
      </div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
        <button class="btn" id="set-baseline" data-run="${run.id}" data-is="${run.is_baseline ? "1" : "0"}">${run.is_baseline ? "★ Baseline — click to clear" : "Set as baseline"}</button>
        <p class="hint" style="margin:6px 0 0">Mark this run as your known-good reference. Future runs are compared against it — so a regression is caught even when every recent run is equally bad.</p>
        <p class="hint" id="baseline-status" hidden></p>
      </div>
      <p class="hint" id="exp-status" hidden></p>
    </div>`;
}

/* Per-endpoint table. Only shown when there is more than one endpoint — a
   single-endpoint test already says everything in the aggregate, and a one-row
   table is noise. Slowest p95 first: the point is that a bad endpoint cannot
   hide inside a healthy blended average. */
// NOTE: mirrors subSampleSummary in worker/subsample_summary.mjs — browser code
// cannot import server modules (app.js is a plain <script>, no build step). The
// worker-side copy is the one under unit test; this one is presentation only.
// If you change the summary text, change BOTH.
function subSampleSummary(parent, rows) {
  if (!parent || !Array.isArray(rows)) return null;
  const kids = rows.filter((r) => r && r.sub_sample && r.sub_of === parent.name);
  if (!kids.length) return null;
  const hops = kids.filter((r) => r.redirect_hop);
  const redirectMs = hops.reduce((n, r) => n + (Number(r.avg_ms) || 0), 0);
  const parts = [kids.length + " sub-request" + (kids.length === 1 ? "" : "s")];
  if (hops.length && redirectMs > 0) {
    const t = redirectMs >= 1000 ? +(redirectMs / 1000).toFixed(1) + "s" : Math.round(redirectMs) + "ms";
    parts.push(t + " in redirect" + (hops.length === 1 ? "" : "s"));
  }
  return { count: kids.length, text: parts.join(" \u00b7 ") };
}

// NOTE: mirrors statusRollup in worker/statuscodes.mjs — browser code cannot
// import server modules (app.js is a plain <script>, no build step). The
// worker-side copy is the one under unit test. Change BOTH.
function statusStripHtml(s) {
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
  const list = [...counts.entries()].sort((a, b) => a[0] - b[0])
    .map(([code, count]) => ({ code, count }));
  /* A status roll-up counts RESPONSES. Connection refused / timeout / reset
     produce NO code at all, so a dead-target run would show a tidy strip beside
     a 100% error rate. Name the silence. */
  const missing = total - coded;
  if (missing > 0) list.push({ code: 0, count: missing });
  const showPct = list.length > 1 && total > 0;
  const colorOf = (c) =>
    c === 0 ? "var(--coral)" :
    c >= 500 ? "var(--coral)" :
    c >= 400 ? "var(--amber, #d98324)" :
    c >= 300 ? "var(--muted)" : "inherit";
  const chips = list.map((x) => {
    const label = x.code === 0 ? "no response" : String(x.code);
    const pct = showPct ? ` <span class="hint">(${((x.count / total) * 100).toFixed(1)}%)</span>` : "";
    return `<span style="white-space:nowrap;color:${colorOf(x.code)}">` +
      `<b>${escapeHtml(label)}</b> \u00d7 ${x.count.toLocaleString()}${pct}</span>`;
  }).join("");
  return `<div class="ai-card" style="margin:14px 0">
      <span class="ai-eyebrow">HTTP status codes</span>
      <p class="hint" style="margin:6px 0 10px">What the target actually answered, across every request in this run.</p>
      <div style="font-size:13px;line-height:1.9;display:flex;flex-wrap:wrap;gap:4px 18px">${chips}</div>
    </div>`;
}

function endpointTableHtml(s) {
  const rows = s && s.per_endpoint;
  if (!Array.isArray(rows)) return "";
  const parents = rows.filter((r) => !r.sub_sample);
  const hasSubs = rows.some((r) => r.sub_sample);
  /* Was: hide below 2 rows. Now: 2+ parents OR any sub-samples — one endpoint
     with a redirect chain is exactly the case worth showing. */
  if (parents.length < 2 && !hasSubs) return "";

  const body = rows
    .map((r) => {
      const bad = (r.errors || 0) > 0;
      const st = [];
      if (bad) st.push("color:var(--coral)");
      /* Sub-samples start hidden: ten endpoints with redirect chains is a thirty
         row table. Parents are the question; hops are the detail. */
      if (r.sub_sample) st.push("display:none");
      const cls = r.sub_sample ? ' class="ep-sub" data-parent="' + escapeHtml(r.sub_of) + '"' : "";
      let nameHtml;
      if (r.sub_sample) {
        const tag = r.redirect_hop ? "\u21b3 redirect hop" : "\u21b3 sub-request";
        nameHtml = `<span style="opacity:.75;padding-left:18px">${escapeHtml(r.name)}</span>` +
          `<span class="hint" style="margin-left:8px">&nbsp;${tag}</span>`;
      } else {
        const sum = subSampleSummary(r, rows);
        if (sum) {
          /* A collapsed parent must still SAY what is beneath it, redirect cost
             included — otherwise collapsing quietly undoes "label, don't fold". */
          nameHtml = `<button type="button" class="ep-toggle" data-parent="${escapeHtml(r.name)}" ` +
            `aria-expanded="false" style="background:none;border:0;color:inherit;font:inherit;cursor:pointer;padding:0">` +
            `<span class="ep-caret">\u25b8</span> ${escapeHtml(r.name)}</button>` +
            `<span class="hint" style="margin-left:8px">&nbsp;${escapeHtml(sum.text)}</span>`;
        } else {
          nameHtml = escapeHtml(r.name);
        }
      }
      return `<tr${cls}${st.length ? ` style="${st.join(";")}"` : ""}>` +
        `<td style="padding:6px 10px">${nameHtml}</td>` +
        `<td style="padding:6px 10px;text-align:right">${r.requests}</td>` +
        `<td style="padding:6px 10px;text-align:right"><b>${r.errors}</b></td>` +
        `<td style="padding:6px 10px;text-align:right">${r.error_rate}%</td>` +
        `<td style="padding:6px 10px;text-align:right">${r.avg_ms} ms</td>` +
        `<td style="padding:6px 10px;text-align:right">${r.p95_ms} ms</td>` +
        `<td style="padding:6px 10px;text-align:right">${r.p99_ms} ms</td></tr>`;
    })
    .join("");

  return `<div class="ai-card" style="margin:14px 0">
      <span class="ai-eyebrow">Per-endpoint breakdown</span>
      <p class="hint" style="margin:6px 0 10px">Slowest first. The headline numbers below can look healthy while a single endpoint is not \u2014 this is where to look.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em">
          <th style="padding:6px 10px">Endpoint</th>
          <th style="padding:6px 10px;text-align:right">Reqs</th>
          <th style="padding:6px 10px;text-align:right">Errors</th>
          <th style="padding:6px 10px;text-align:right">Err %</th>
          <th style="padding:6px 10px;text-align:right">Avg</th>
          <th style="padding:6px 10px;text-align:right">p95</th>
          <th style="padding:6px 10px;text-align:right">p99</th>
        </tr>${body}
      </table>
    </div>`;
}

/* One delegated listener covers every toggle, including after a re-render. */
document.addEventListener("click", function (ev) {
  const btn = ev.target && ev.target.closest && ev.target.closest(".ep-toggle");
  if (!btn) return;
  const parent = btn.getAttribute("data-parent") || "";
  const open = btn.getAttribute("aria-expanded") === "true";
  btn.setAttribute("aria-expanded", open ? "false" : "true");
  const caret = btn.querySelector(".ep-caret");
  if (caret) caret.textContent = open ? "\u25b8" : "\u25be";
  const subs = document.querySelectorAll(".ep-sub");
  for (let i = 0; i < subs.length; i++) {
    if (subs[i].getAttribute("data-parent") === parent) {
      subs[i].style.display = open ? "none" : "";
    }
  }
});


/* The server's effective limits. The form used to hardcode max="500" etc., which
   silently contradicted .env — one source of truth now. */
let LIMITS = { max_virtual_users: 500, max_duration_secs: 3600, max_shards: 10, max_browser_users: 5, max_browser_loops: 10 };
async function loadLimits() {
  try {
    LIMITS = await api("/config");
    const set = (sel, max) => { const el = $(sel); if (el && max > 0) el.max = String(max); };
    set('[name="virtual_users"]', LIMITS.max_virtual_users);
    set('[name="bg_users"]', LIMITS.max_virtual_users);
    set('[name="shard_count_override"]', LIMITS.max_shards);
    set('[name="browser_users"]', LIMITS.max_browser_users);
    set('[name="loops"]', LIMITS.max_browser_loops);
    const dur = $('[name="duration_secs"]');
    if (dur) {
      if (LIMITS.max_duration_secs > 0) dur.max = String(LIMITS.max_duration_secs);
      else dur.removeAttribute("max"); // 0 = no limit
    }
  } catch (e) {
    // Keep the defaults, but SAY SO. A bare catch here once swallowed a
    // ReferenceError for six weeks: loadLimits() was invoked above the
    // definitions of $ and api, so every server limit in .env was silently
    // ignored by the form while the comment below claimed one source of truth.
    console.error("[loadstar] /config failed — form limits fall back to HTML defaults:", e);
  }
}

const fmtMs = (v) => (v == null ? "—" : Number(v) < 1 ? "<1 ms" : `${v} ms`);
/* Loadstar UI — zero-dependency SPA. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
/* ————— API key —————
   apiKeyAuth guards every /api route. With LOADSTAR_API_KEY unset the API runs
   in open mode and no key is needed; set it and EVERY request must carry
   x-api-key. The UI used to send nothing at all, so turning auth on killed the
   whole SPA. The key lives in localStorage: an admin key in the browser is a
   real trade-off, and the UI says so out loud rather than hiding it. */
const LS_API_KEY = "loadstar_api_key";
const getApiKey = () => {
  try { return localStorage.getItem(LS_API_KEY) || ""; } catch { return ""; }
};
const setApiKey = (v) => {
  try {
    if (v) localStorage.setItem(LS_API_KEY, v);
    else localStorage.removeItem(LS_API_KEY);
  } catch { /* private mode / storage disabled — the key just will not persist */ }
};

/* Headers apply LAST, deliberately. The old helper spread ...opts AFTER headers,
   so any caller passing its own headers silently wiped the defaults — which is
   exactly how the script-upload path ended up bypassing this. */
const authHeaders = (extra) => {
  const h = { "content-type": "application/json", ...(extra || {}) };
  const k = getApiKey();
  if (k) h["x-api-key"] = k;
  return h;
};

/* EVERY call to /api goes through here. There are no other fetch call sites —
   if you add one, you have re-introduced Bug 4. */
const api = (p, opts = {}) =>
  fetch("/api" + p, { ...opts, headers: authHeaders(opts.headers) }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) {
        showApiKeyBar(true);
        throw new Error(
          "This Loadstar needs an API key. Enter it in the bar at the top of the page. " +
          "(It is the LOADSTAR_API_KEY value from your .env — leave that empty for open mode.)"
        );
      }
      throw new Error(j.error || r.statusText);
    }
    return j;
  });

// Invoked HERE, not at the definition: loadLimits needs $ and api, both
// declared below its own body. Called earlier it throws ReferenceError.
loadLimits();

let activeRunPoll = null;

/* ————— View switching ————— */
function show(view) {
  $$(".view").forEach((v) => (v.hidden = true));
  $("#view-" + view).hidden = false;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  if (view === "runs") loadRuns();
  if (view === "tests") loadTests();
  if (view === "schedules") loadSchedules();
}
$$(".tab").forEach((t) => t.addEventListener("click", () => show(t.dataset.view)));
$("#back-to-runs").addEventListener("click", () => { stopPolling(); show("runs"); });

/* ————— Mode picker & body visibility ————— */
let mode = "load";
let engine = "jmeter";
$$(".eng").forEach((b) => b.addEventListener("click", () => {
  engine = b.dataset.engine;
  $$(".eng").forEach((x) => x.classList.toggle("active", x === b));
}));
function collectSla() {
  const n = (name) => { const v = new FormData($("#test-form")).get(name); return v ? Number(v) : null; };
  const sla = testType === "browser"
    ? { min_pass_rate: n("sla_min_pass"), max_avg_flow_ms: n("sla_max_flow") }
    : { max_p95_ms: n("sla_max_p95"), max_error_rate: n("sla_max_err") };
  Object.keys(sla).forEach((k) => sla[k] == null && delete sla[k]);
  return Object.keys(sla).length ? sla : undefined;
}
$("#mode-picker").addEventListener("click", (e) => {
  const btn = e.target.closest(".mode");
  if (!btn) return;
  mode = btn.dataset.mode;
  /* Scoped to #mode-picker. The engine buttons are class="mode eng" — they
     borrow `mode` for styling — so an unscoped $$(".mode") also stripped
     `active` from JMeter/k6 on every mode click. The `engine` variable kept its
     value, so runs used the right engine while the UI showed none selected. */
  $$(".mode", $("#mode-picker")).forEach((m) => m.classList.toggle("active", m === btn));
});
$('select[name="method"]').addEventListener("change", (e) => {
  $("#body-field").hidden = e.target.value === "GET" || e.target.value === "HEAD";
});

/* ————— Test type toggle ————— */
let testType = null;
const STEP_ACTIONS = [
  ["click", "Click", "selector"],
  ["fill", "Type into", "selector+value"],
  ["expect_text", "Check: text appears", "value"],
  ["expect_no_text", "Check: text is NOT there", "value"],
  ["expect_visible", "Check: element is visible", "selector"],
  ["expect_url", "Check: URL contains", "value"],
  ["goto", "Go to another page", "value"],
  ["wait_for", "Wait for element", "selector"],
  ["pause", "Pause (ms)", "value"],
];
$("#type-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".ttype");
  if (!btn) return;
  testType = btn.dataset.type;
  $("#test-form").classList.remove("no-type");
  $$(".ttype").forEach((b) => b.classList.toggle("active", b === btn));
  $$(".http-only").forEach((el) => (el.hidden = testType !== "http"));
  $$(".browser-only").forEach((el) => (el.hidden = testType !== "browser"));
  $$(".script-only").forEach((el) => (el.hidden = testType !== "script"));
  $$(".not-script").forEach((el) => (el.hidden = testType === "script"));
  $$(".http-only, .browser-only").forEach((el) => { if (testType === "script") el.hidden = true; });
  $("#target-label").textContent = testType === "browser" ? "Start page URL" : "Target URL";
  $('input[name="target_url"]').placeholder =
    testType === "browser" ? "https://staging.example.com/login" : "https://staging.example.com/api/checkout";
  // required attrs only apply to visible fields
  if (testType === "browser") { $("#body-field").hidden = true; if (!$$(".step-row").length) addStepRow(); }
  else $("#body-field").hidden = $('select[name="method"]').value === "GET";
});

/* ————— Step builder ————— */
function addStepRow(preset = {}) {
  const row = document.createElement("div");
  row.className = "step-row";
  row.innerHTML = `
    <span class="n"></span>
    <select class="s-action">${STEP_ACTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
    <input class="s-selector" placeholder="selector, e.g. text=Sign in or #email" />
    <input class="s-value" placeholder="value" />
    <button type="button" class="del" title="Remove step">×</button>`;
  $("#steps").appendChild(row);
  const sync = () => {
    const needs = STEP_ACTIONS.find(([v]) => v === row.querySelector(".s-action").value)[2];
    row.querySelector(".s-selector").style.visibility = needs.includes("selector") ? "visible" : "hidden";
    const val = row.querySelector(".s-value");
    val.style.visibility = needs.includes("value") ? "visible" : "hidden";
    val.placeholder = {
      fill: "text to type",
      expect_text: 'text that should appear, e.g. "Welcome back"',
      expect_no_text: 'text that must NOT appear, e.g. "Error"',
      expect_url: "part of the URL, e.g. /checkout",
      goto: "https://…",
      pause: "milliseconds, e.g. 1000",
    }[row.querySelector(".s-action").value] || "value";
    renumber();
  };
  row.querySelector(".s-action").addEventListener("change", sync);
  row.querySelector(".del").addEventListener("click", () => { row.remove(); renumber(); });
  if (preset.action) row.querySelector(".s-action").value = preset.action;
  if (preset.selector) row.querySelector(".s-selector").value = preset.selector;
  if (preset.value) row.querySelector(".s-value").value = preset.value;
  sync();
}
function renumber() { $$(".step-row .n").forEach((n, i) => (n.textContent = i + 1)); }
function collectSteps() {
  return $$(".step-row").map((row) => {
    const action = row.querySelector(".s-action").value;
    const needs = STEP_ACTIONS.find(([v]) => v === action)[2];
    const s = { action };
    if (needs.includes("selector")) s.selector = row.querySelector(".s-selector").value.trim();
    if (needs.includes("value")) s.value = row.querySelector(".s-value").value.trim();
    return s;
  });
}
$("#add-step").addEventListener("click", () => addStepRow());

/* ————— Selenium .side import ————— */
function sideSelector(target = "") {
  const [kind, ...rest] = target.split("=");
  const v = rest.join("=");
  switch (kind) {
    case "id": return "#" + v;
    case "css": return v;
    case "name": return `[name="${v}"]`;
    case "linkText": return "text=" + v;
    case "xpath": return "xpath=" + v;   // Playwright supports xpath= natively
    default: return target;              // pass through as-is
  }
}
function convertSide(side) {
  const commands = side.tests?.[0]?.commands || [];
  const steps = [], skipped = [];
  let startUrl = null;
  const base = side.url || "";
  for (const c of commands) {
    switch (c.command) {
      case "open": {
        let abs; try { abs = new URL(c.target, base).href; } catch { abs = c.target; }
        if (!startUrl && !steps.length) startUrl = abs;
        else steps.push({ action: "goto", value: abs });
        break;
      }
      case "click": case "clickAt": case "submit":
        steps.push({ action: "click", selector: sideSelector(c.target) }); break;
      case "type": case "sendKeys":
        steps.push({ action: "fill", selector: sideSelector(c.target), value: c.value || "" }); break;
      case "assertText": case "verifyText": case "assertTextPresent":
        steps.push({ action: "expect_text", value: c.value || c.target || "" }); break;
      case "waitForElementVisible": case "waitForElementPresent":
        steps.push({ action: "wait_for", selector: sideSelector(c.target) }); break;
      case "pause":
        steps.push({ action: "pause", value: c.target || c.value || "1000" }); break;
      default:
        skipped.push(c.command);
    }
  }
  return { startUrl, steps, skipped: [...new Set(skipped)] };
}
$("#side-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const status = $("#side-status");
  status.hidden = false; status.className = "hint";
  if (!file) { status.hidden = true; return; }
  try {
    const side = JSON.parse(await file.text());
    const { startUrl, steps, skipped } = convertSide(side);
    if (!steps.length && !startUrl) throw new Error("No convertible commands found in this file.");
    $("#steps").innerHTML = "";
    if (startUrl) $('input[name="target_url"]').value = startUrl;
    if (side.tests?.[0]?.name && !$('input[name="name"]').value)
      $('input[name="name"]').value = side.tests[0].name;
    steps.forEach((s) => addStepRow(s));
    status.textContent = `Imported ${steps.length} steps from "${file.name}".` +
      (skipped.length ? ` Skipped unsupported commands: ${skipped.join(", ")}. Review the steps before running.` : "");
    status.classList.add(skipped.length ? "err" : "ok");
  } catch (err) {
    status.textContent = "Could not read that .side file: " + err.message;
    status.classList.add("err");
  }
  e.target.value = "";
});

/* ————— Browser under load toggle ————— */
$("#bg-load").addEventListener("change", (e) => ($("#bg-fields").hidden = !e.target.checked));


/* ————— Tests library ————— */
let testsFilter = "all";
let runsFilter = "all";
function wireFilterBar(barId, setFn) {
  const bar = document.getElementById(barId);
  if (!bar || bar.dataset.wired) return;
  bar.dataset.wired = "1";
  bar.addEventListener("click", (e) => {
    const b = e.target.closest(".filter");
    if (!b) return;
    [...bar.querySelectorAll(".filter")].forEach((x) => x.classList.toggle("active", x === b));
    setFn(b.dataset.filter);
  });
}
async function loadTests() {
  const list = $("#tests-list");
  wireFilterBar("tests-filter", (f) => { testsFilter = f; loadTests(); });
  let tests;
  try { tests = await api("/tests"); }
  catch (e) { list.innerHTML = `<p class="empty">Could not load tests: ${escapeHtml(e.message)}</p>`; return; }
  if (testsFilter !== "all") tests = tests.filter((t) => (t.test_type === "browser" ? "browser" : "http") === testsFilter);
  if (!tests.length) { list.innerHTML = '<p class="empty">No tests match this filter.</p>'; return; }
  list.innerHTML = "";
  for (const t of tests) {
    const isBrowser = t.test_type === "browser";
    const engine = isBrowser ? "playwright" : (t.engine || "jmeter");
    const scriptHref = isBrowser ? null : `/api/tests/${t.id}/${engine === "k6" ? "k6" : "jmx"}`;
    const row = document.createElement("div");
    row.className = "run-row";
    row.style.cursor = "default";
    row.innerHTML = `
      <span class="run-name">${escapeHtml(t.name)}</span>
      <span class="run-meta">${isBrowser ? "browser" : escapeHtml(t.mode || "load")}</span>
      <span class="run-meta">${escapeHtml(engine)}</span>
      <span class="run-meta">${escapeHtml(hostOf(t.target_url))}</span>
      <button class="btn primary" data-run="${t.id}">Run again</button>
      ${scriptHref ? `<a class="btn" href="${scriptHref}" download>Download script</a>` : ""}
      <button class="btn ghost" data-del="${t.id}">Delete</button>`;
    row.querySelector("[data-run]").addEventListener("click", async (e) => {
      e.target.disabled = true; e.target.textContent = "Starting…";
      try {
        const run = await api(`/tests/${t.id}/runs`, { method: "POST" });
        openReport(run.id);
      } catch (err) { e.target.disabled = false; e.target.textContent = "Run again"; alert(err.message); }
    });
    row.querySelector("[data-del]").addEventListener("click", async () => {
      if (!confirm(`Delete "${t.name}"? This removes the test and its run history.`)) return;
      try { await api("/tests/" + t.id, { method: "DELETE" }); loadTests(); }
      catch (err) { alert(err.message); }
    });
    list.appendChild(row);
  }
}

/* ————— Schedules ————— */
async function loadSchedules() {
  // populate test picker
  const tests = await api("/tests").catch(() => []);
  $("#sched-test").innerHTML = tests
    .map((t) => `<option value="${t.id}">${escapeHtml(t.name)} (${t.test_type})</option>`)
    .join("") || "<option value=''>No tests yet — create one first</option>";
  const list = $("#schedules-list");
  const scheds = await api("/schedules").catch(() => []);
  list.innerHTML = scheds.length ? "" : '<p class="empty">No schedules yet.</p>';
  for (const s of scheds) {
    const row = document.createElement("div");
    row.className = "run-row";
    row.style.cursor = "default";
    row.innerHTML = `
      <span class="run-name">${escapeHtml(s.test_name)}</span>
      <span class="run-meta">every ${s.interval_minutes} min</span>
      <span class="run-meta">${s.webhook_url ? "alerts on" : "no alerts"}</span>
      <span class="run-meta">${s.last_run_at ? "last: " + new Date(s.last_run_at).toLocaleString() : "not run yet"}</span>
      <button class="btn ghost" data-del="${s.id}">Delete</button>`;
    row.querySelector("[data-del]").addEventListener("click", async () => {
      await api("/schedules/" + s.id, { method: "DELETE" });
      loadSchedules();
    });
    list.appendChild(row);
  }
}
$("#schedule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("#sched-status");
  status.className = "status";
  try {
    await api("/schedules", {
      method: "POST",
      body: JSON.stringify({
        test_id: $("#sched-test").value,
        interval_minutes: Number($("#sched-interval").value),
        webhook_url: $("#sched-webhook").value.trim() || null,
      }),
    });
    status.textContent = "Schedule added."; status.classList.add("ok");
    $("#sched-webhook").value = "";
    loadSchedules();
  } catch (err) {
    status.textContent = err.message; status.classList.add("err");
  }
});



/* ————— Uploaded script (bring your own JMeter/k6) ————— */
let __scriptText = null, __scriptEngine = null;
$("#script-file")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const info = $("#script-info"), detected = $("#script-detected"), warnEl = $("#script-warnings"), runBtn = $("#script-run");
  warnEl.textContent = ""; info.hidden = true; __scriptText = null;
  if (!file) { runBtn.disabled = true; return; }
  const nameLc = file.name.toLowerCase();
  if (!nameLc.endsWith(".jmx") && !nameLc.endsWith(".js")) {
    info.hidden = false; detected.textContent = ""; warnEl.textContent = "Only .jmx (JMeter) or .js (k6) files can be uploaded.";
    runBtn.disabled = true; return;
  }
  __scriptText = await file.text();
  __scriptEngine = nameLc.endsWith(".jmx") ? "jmeter" : "k6";
  info.hidden = false;
  detected.textContent = `Detected ${__scriptEngine === "jmeter" ? "JMeter (.jmx)" : "k6 (.js)"} — ${(__scriptText.length/1024).toFixed(1)} KB.`;
  if (!$('input[name="script_name"]').value) $('input[name="script_name"]').value = file.name.replace(/\.(jmx|js)$/i, "");
  runBtn.disabled = false;
});
async function handleScriptUpload() {
  const status = $("#script-status"), warnEl = $("#script-warnings"), runBtn = $("#script-run");
  const name = $('input[name="script_name"]').value.trim();
  if (!__scriptText) { status.textContent = "Choose a .jmx or .js file first."; return; }
  if (!name) { status.textContent = "Give the test a name."; return; }
  runBtn.disabled = true; status.textContent = "Uploading…";
  try {
    /* Was two raw fetch() calls that bypassed api() entirely — so with auth on,
       script upload failed at BOTH points while everything else looked fixed.
       Both now go through api(), which attaches the key. */
    const data = await api("/tests/upload-script", {
      method: "POST",
      body: JSON.stringify({ name, engine: __scriptEngine, script: __scriptText, target_url: "http://demo" }),
    });
    if (data.warnings && data.warnings.length) {
      warnEl.textContent = "⚠ " + data.warnings.join("  ⚠ ");
      $("#script-info").hidden = false;
    }
    status.textContent = "Uploaded. Starting run…";
    await api(`/tests/${data.id}/runs`, { method: "POST" });
    status.textContent = "Run started — see the Runs tab.";
    if (typeof loadRuns === "function") loadRuns();
  } catch (err) {
    status.textContent = "Error: " + err.message; runBtn.disabled = false;
  }
}
$("#script-run")?.addEventListener("click", handleScriptUpload);

/* ————— Multi-request builder ————— */
let multiOn = false;
const MR_METHODS = ["GET","POST","PUT","PATCH","DELETE","HEAD"];
function addRequestRow(preset = {}) {
  const row = document.createElement("div");
  row.className = "request-row";
  row.innerHTML = `
    <select class="rq-method">${MR_METHODS.map(m => `<option>${m}</option>`).join("")}</select>
    <input class="rq-path" placeholder="/path  e.g. /login" />
    <button type="button" class="del" title="Remove">×</button>
    <textarea class="rq-body" rows="2" placeholder='optional body / headers as JSON, e.g. {"Authorization":"Bearer …"}' hidden></textarea>
    <input class="rq-headers" placeholder='headers JSON (optional) e.g. {"Content-Type":"application/json"}' style="grid-column:2/3" />
    <div class="rq-capture" style="grid-column:2/3;display:flex;gap:6px;align-items:center;margin-top:4px">
      <span style="font-size:11px;color:var(--ink-2)">capture →</span>
      <input class="rq-var" placeholder="var name e.g. token" style="width:130px" />
      <select class="rq-src"><option value="">— from —</option><option value="json">JSON body</option><option value="header">response header</option><option value="regex">regex</option></select>
      <input class="rq-expr" placeholder="\$.token / Set-Cookie / pattern" style="flex:1" />
    </div>
    <div class="rq-think" style="grid-column:2/3;display:flex;gap:6px;align-items:center;margin-top:4px">
      <span style="font-size:11px;color:var(--ink-2)" title="Pause after this request, like a real user reading the page.">think time →</span>
      <input class="rq-think-ms" type="number" min="0" step="100" placeholder="ms e.g. 1000" style="width:130px" />
      <input class="rq-think-jit" type="number" min="0" max="90" placeholder="jitter % e.g. 20" style="width:130px" />
      <span style="font-size:11px;color:var(--ink-2)">blank = no pause</span>
    </div>
    <div class="rq-assert" style="grid-column:2/3;display:flex;gap:6px;align-items:center;margin-top:4px;flex-wrap:wrap">
      <span style="font-size:11px;color:var(--ink-2)" title="Check the response content, not just the status code.">assert &rarr;</span>
      <input class="rq-as-status" type="number" min="100" max="599" placeholder="200" title="Exact status code required. Blank = any 2xx/3xx passes." style="width:80px" />
      <select class="rq-as-mode" style="width:110px" title="Check the response body for text.">
        <option value="">&mdash; body &mdash;</option>
        <option value="contains">contains</option>
        <option value="excludes">excludes</option>
      </select>
      <input class="rq-as-text" placeholder='e.g. "order confirmed"' title="Body must contain (or must not contain) this text." style="flex:1;min-width:160px" />
      <span style="flex-basis:100%;height:0"></span>
      <span style="font-size:11px;color:var(--ink-2);margin-left:52px">header &rarr;</span>
      <input class="rq-as-hname" placeholder="Content-Type" title="Header name (case-insensitive)." style="width:150px" />
      <input class="rq-as-hval" placeholder="image/png" title="The header's value must contain this." style="width:170px" />
      <span style="font-size:11px;color:var(--ink-2);flex-basis:100%;line-height:1.5;margin-top:2px">
        Checks the response &mdash; not just that it arrived. Fill any combination; <b>all filled checks must pass</b>. Blank = only requires status 2xx/3xx.<br>
        Example: status <code>200</code> + body contains <code>order confirmed</code> catches an endpoint that returns 200 with an error page.
        Header <code>Content-Type</code> contains <code>image/png</code> catches a CDN serving an error page where an image should be.
      </span>
    </div>`;
  const bodyEl = row.querySelector(".rq-body");
  const methodEl = row.querySelector(".rq-method");
  const syncBody = () => { bodyEl.hidden = (methodEl.value === "GET" || methodEl.value === "HEAD"); };
  methodEl.addEventListener("change", syncBody);
  row.querySelector(".del").addEventListener("click", () => row.remove());
  if (preset.method) methodEl.value = preset.method;
  if (preset.path) row.querySelector(".rq-path").value = preset.path;
  if (preset.body) bodyEl.value = preset.body;
  if (preset.headers) row.querySelector(".rq-headers").value = typeof preset.headers === "string" ? preset.headers : JSON.stringify(preset.headers);
  if (preset.extract) {
    if (preset.extract.var) row.querySelector(".rq-var").value = preset.extract.var;
    if (preset.extract.source) row.querySelector(".rq-src").value = preset.extract.source;
    if (preset.extract.path) row.querySelector(".rq-expr").value = preset.extract.path;
  }
  if (preset.think_time_ms) row.querySelector(".rq-think-ms").value = preset.think_time_ms;
  if (preset.think_time_jitter_pct) row.querySelector(".rq-think-jit").value = preset.think_time_jitter_pct;
  if (preset.assert) {
    if (preset.assert.status != null) row.querySelector(".rq-as-status").value = preset.assert.status;
    if (preset.assert.body_contains) { row.querySelector(".rq-as-mode").value = "contains"; row.querySelector(".rq-as-text").value = preset.assert.body_contains; }
    else if (preset.assert.body_excludes) { row.querySelector(".rq-as-mode").value = "excludes"; row.querySelector(".rq-as-text").value = preset.assert.body_excludes; }
    if (preset.assert.header_name) row.querySelector(".rq-as-hname").value = preset.assert.header_name;
    if (preset.assert.header_contains) row.querySelector(".rq-as-hval").value = preset.assert.header_contains;
  }
  syncBody();
  $("#requests-rows").appendChild(row);
}
function collectRequests() {
  return $$(".request-row").map((row) => {
    const method = row.querySelector(".rq-method").value;
    const path = row.querySelector(".rq-path").value.trim() || "/";
    const req = { method, path };
    const bodyEl = row.querySelector(".rq-body");
    if (!bodyEl.hidden && bodyEl.value.trim()) req.body = bodyEl.value.trim();
    const h = row.querySelector(".rq-headers").value.trim();
    if (h) { try { req.headers = JSON.parse(h); } catch { throw new Error("Headers in a request row must be valid JSON."); } }
    const evar = row.querySelector(".rq-var")?.value.trim();
    const esrc = row.querySelector(".rq-src")?.value;
    const eexpr = row.querySelector(".rq-expr")?.value.trim();
    if (evar && esrc) req.extract = { var: evar, source: esrc, path: eexpr || "" };
    const tms = Number(row.querySelector(".rq-think-ms")?.value);
    if (Number.isFinite(tms) && tms > 0) {
      req.think_time_ms = tms;
      const tjit = Number(row.querySelector(".rq-think-jit")?.value);
      if (Number.isFinite(tjit) && tjit > 0) req.think_time_jitter_pct = Math.min(tjit, 90);
    }
    const asStatus = Number(row.querySelector(".rq-as-status")?.value);
    const asMode = row.querySelector(".rq-as-mode")?.value;
    const asText = row.querySelector(".rq-as-text")?.value.trim();
    const assert = {};
    if (Number.isFinite(asStatus) && asStatus >= 100) assert.status = asStatus;
    if (asMode === "contains" && asText) assert.body_contains = asText;
    if (asMode === "excludes" && asText) assert.body_excludes = asText;
    const asHName = row.querySelector(".rq-as-hname")?.value.trim();
    const asHVal = row.querySelector(".rq-as-hval")?.value.trim();
    if (asHName && asHVal) { assert.header_name = asHName; assert.header_contains = asHVal; }
    if (Object.keys(assert).length) req.assert = assert;
    return req;
  });
}
$("#multi-toggle")?.addEventListener("change", (e) => {
  multiOn = e.target.checked;
  $("#requests-builder").hidden = !multiOn;
  // hide the single-request method/body when multi is on
  $('select[name="method"]').closest(".field").style.display = multiOn ? "none" : "";
  $("#body-field").style.display = multiOn ? "none" : "";
  if (multiOn && !$$(".request-row").length) addRequestRow({ method:"GET", path:"/" });
});
$("#add-request")?.addEventListener("click", () => addRequestRow());
function syncDistShards() {
  const mode = $("#dist-mode")?.value;
  const field = $("#dist-shards-field");
  if (field) field.style.display = mode === "on" ? "" : "none";
}
$("#dist-mode")?.addEventListener("change", syncDistShards);
syncDistShards();

/* ————— CSV upload ————— */
let csvData = null;
$("#csv-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const status = $("#csv-status");
  status.hidden = false;
  status.className = "hint";
  csvData = null;
  if (!file) { status.hidden = true; return; }
  if (file.size > 200_000) { status.textContent = "File too large — CSVs must be under 200 KB."; status.classList.add("err"); return; }
  const text = await file.text();
  const lines = text.trim().split("\n");
  const cols = lines[0]?.trim().split(",").map((c) => c.trim()).filter(Boolean);
  if (!cols?.length || lines.length < 2) {
    status.textContent = "This file needs a header row plus at least one data row.";
    status.classList.add("err");
    return;
  }
  csvData = text;
  status.textContent = `Loaded ${lines.length - 1} rows. Available placeholders: ` +
    cols.map((c) => "${" + c + "}").join("  ");
  status.classList.add("ok");
});

/* ————— Create & run ————— */
$("#test-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const status = $("#form-status");
  status.className = "status";
  let headers = {};
  const rawHeaders = f.get("headers")?.trim();
  if (rawHeaders) {
    try { headers = JSON.parse(rawHeaders); }
    catch { status.textContent = "Headers must be valid JSON."; status.classList.add("err"); return; }
  }
  status.textContent = "Creating test…";
  try {
    const payload =
      testType === "browser"
        ? {
            test_type: "browser",
            name: f.get("name"),
            target_url: f.get("target_url"),
            notify_email: f.get("notify_email") || null,
            virtual_users: Number(f.get("browser_users")),
            loops: Number(f.get("loops")),
            browser: $('select[name="browser"]')?.value || "chromium",
            sla: collectSla(),
            browser_steps: collectSteps(),
            background_load: $("#bg-load").checked
              ? { virtual_users: Number(f.get("bg_users")), duration_secs: Number(f.get("bg_duration")) }
              : undefined,
          }
        : {
            test_type: "http",
            name: f.get("name"),
            target_url: f.get("target_url"),
            notify_email: f.get("notify_email") || null,
            engine,
            sla: collectSla(),
            method: f.get("method"),
            headers,
            body: f.get("body") || null,
            mode,
            virtual_users: Number(f.get("virtual_users")),
            ramp_up_secs: Number(f.get("ramp_up_secs")),
            duration_secs: Number(f.get("duration_secs")),
            distribution_mode: f.get("distribution_mode") || "auto",
            shard_count_override: f.get("shard_count_override") ? Number(f.get("shard_count_override")) : undefined,
            csv_data: csvData,
            requests: multiOn ? collectRequests() : undefined,
            cookie_manager: multiOn ? ($("#cookie-mgr")?.checked ?? true) : undefined,
          };
    const test = await api("/tests", { method: "POST", body: JSON.stringify(payload) });
    status.textContent = "Queuing run…";
    const run = await api(`/tests/${test.id}/runs`, { method: "POST" });
    status.textContent = "Run queued.";
    status.classList.add("ok");
    openReport(run.id);
  } catch (err) {
    status.textContent = err.message;
    status.classList.add("err");
  }
});

/* ————— Runs list ————— */
async function loadRuns() {
  const list = $("#runs-list");
  wireFilterBar("runs-filter", (f) => { runsFilter = f; loadRuns(); });
  try {
    let runs = await api("/runs");
    if (runsFilter !== "all") runs = runs.filter((r) => (r.test_type === "browser" ? "browser" : "http") === runsFilter);
    if (!runs.length) { list.innerHTML = '<p class="empty">No runs yet. Configure a test to fire the first one.</p>'; return; }
    list.innerHTML = "";
    for (const r of runs) {
      const row = document.createElement("button");
      row.className = "run-row";
      const isBrowser = r.test_type === "browser";
      const stat = isBrowser
        ? (r.summary?.pass_rate != null ? r.summary.pass_rate + "% passed" : "")
        : (r.summary?.p95_ms != null ? "p95 " + fmtMs(r.summary.p95_ms) : "");
      row.innerHTML = `
        <span class="run-name">${escapeHtml(r.test_name)}</span>
        <span class="run-meta">${isBrowser ? "browser · playwright · " + escapeHtml(r.browser || "chromium") : escapeHtml(r.mode || "") + (r.engine ? " · " + escapeHtml(r.engine) : "")}</span>
        <span class="run-meta">${stat}</span>
        <span class="run-meta">${new Date(r.created_at).toLocaleString()}</span>
        <span class="pill ${r.status}">${r.status}</span>`;
      row.addEventListener("click", () => openReport(r.id));
      list.appendChild(row);
    }
  } catch (e) {
    list.innerHTML = `<p class="empty">Could not load runs: ${escapeHtml(e.message)}</p>`;
  }
}

/* ————— Report ————— */
function stopPolling() {
  if (activeRunPoll) { clearInterval(activeRunPoll); activeRunPoll = null; }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  setScopeIdle();
}

let tickTimer = null;
let lastRun = null;

function openReport(runId) {
  show("report");
  renderReport(runId);
  stopPolling();
  // Poll the server every 3s for real data…
  activeRunPoll = setInterval(async () => {
    const run = await api("/runs/" + runId).catch(() => null);
    if (!run) return;
    lastRun = run;
    renderRun(run);
    if (["done", "failed", "cancelled"].includes(run.status)) stopPolling();
  }, 3000);
  // …and re-render every 1s in between so the elapsed timer/progress bar advance smoothly.
  tickTimer = setInterval(() => {
    if (lastRun && (lastRun.status === "running" || lastRun.status === "queued")) renderRun(lastRun);
  }, 1000);
}
async function renderReport(runId) {
  const run = await api("/runs/" + runId).catch((e) => ({ error: e.message }));
  if (run.error) { $("#report").innerHTML = `<p class="empty">${escapeHtml(run.error)}</p>`; return; }
  renderRun(run);
}


/* Human-readable duration + start/end for a finished run. */
function durationLine(run, summary) {
  if (run.status !== "done" && run.status !== "failed") return "";
  // Prefer measured wall time; fall back to started→finished timestamps.
  let secs = summary?.wall_seconds;
  if (secs == null && run.started_at && run.finished_at)
    secs = Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000);
  const fmt = (s) => s == null ? "—" : s >= 60 ? `${Math.floor(s/60)}m ${s%60}s` : `${s}s`;
  const t = (ts) => ts ? new Date(ts).toLocaleTimeString() : "—";
  const dateStr = run.started_at ? new Date(run.started_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : (run.created_at ? new Date(run.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
  const range = run.started_at && run.finished_at ? ` · ${t(run.started_at)} → ${t(run.finished_at)}` : "";
  return `<span class="run-meta">${dateStr ? dateStr + " · " : ""}duration ${fmt(secs)}${range}</span>`;
}

function renderRun(run) {
  if (run.test_type === "browser") return renderBrowserRun(run);
  const s = run.summary || {};
  const running = ["running", "queued", "coordinating", "analyzing"].includes(run.status);
  setScope(run);

  $("#report").innerHTML = `
    <div class="report-head">
      <h1>${escapeHtml(run.test_name || "Run")}</h1>
      <span class="pill ${run.status}">${run.status}</span>
      <!-- Engine belongs here: two runs of the same target at the same VU count can
           differ by 3x purely on engine (JMeter caps ~2000 concurrent threads on 4
           vCPUs where k6 reaches 5000 — see PART L). A report that omits which engine
           produced the measurement cannot be compared to another. tests.engine is
           already in the /runs/:id SELECT; it was simply never rendered. -->
      <span class="run-meta">${escapeHtml(run.mode || "")} · ${escapeHtml(run.engine || "jmeter")} · ${run.virtual_users ?? "?"} VU · ${escapeHtml(hostOf(run.target_url))}${run.summary?.distributed ? ` · ${run.summary.shards} generators` : ""}</span>
      ${durationLine(run, run.summary)}
    </div>
    ${run.error ? `<p class="empty">Error: ${escapeHtml(run.error)}</p>` : ""}
    ${running ? progressPanel(run) : ""}
    ${running ? `<div style="margin-top:10px">
      <button class="btn" id="stop-run" data-run="${run.id}">Stop test</button>
      <p class="hint" style="margin:6px 0 0">Stops the engine. Results collected so far are kept and the run is marked <b>cancelled</b> — it will not be used for comparisons or as a baseline.</p>
      <p class="hint" id="stop-status" hidden></p>
    </div>` : ""}
    <div class="metric-grid">
      ${m("Requests", s.total_requests)}
      ${m("Throughput", s.throughput_rps, "req/s")}
      ${m("Error rate", s.error_rate, "%", (s.error_rate ?? 0) > 1)}
      ${(s.assertion_total ?? 0) > 0 ? m("Assertion fails", s.assertion_failures + "/" + s.assertion_total, "", (s.assertion_failures ?? 0) > 0) : ""}
      ${m("Avg", fmtMs(s.avg_ms))}
      ${m("p50", fmtMs(s.p50_ms))}
      ${m("p90", fmtMs(s.p90_ms))}
      ${m("p95", fmtMs(s.p95_ms))}
      ${m("p99", fmtMs(s.p99_ms))}
    </div>
    ${run.timeseries?.length ? `
      <div class="chart-card">
        <canvas id="ts-chart" height="220"></canvas>
        <div class="legend">
          <span><i style="background:var(--blue)"></i>response time (ms)</span>
          <span><i style="background:var(--green)"></i>throughput (req/s)</span>
          <span><i style="background:var(--coral)"></i>errors</span>
        </div>
      </div>` : ""}
    ${slaCard(s)}
    <div id="ai-slot"></div>
    ${statusStripHtml(s)}
    ${endpointTableHtml(s)}
    ${exportCard(run)}`;

  if (run.timeseries?.length) drawChart($("#ts-chart"), run.timeseries);
  wireExports(run);

  renderAi(run);
}

function renderBrowserRun(run) {
  const s = run.summary || {};
  /* `analyzing` is NOT terminal. The run has finished generating load but the AI
     analysis is still being written. Stop polling here and the report renders
     "The analysis did not run" for a run whose analysis lands two seconds later. */
  const running = run.status === "running" || run.status === "queued" || run.status === "analyzing";
  setScope(run);

  const stepsTable = s.steps?.length
    ? `<h2>Steps</h2>
       <table class="steps-table">
         <tr><th>#</th><th>Action</th><th>Passed</th><th>Avg time</th><th>First error</th></tr>
         ${s.steps
           .map(
             (st) => `<tr>
               <td class="mono">${st.step}</td>
               <td class="mono">${escapeHtml(st.label)}</td>
               <td class="${st.failed ? "fail" : "ok"}">${st.passed}/${st.runs}</td>
               <td class="mono">${st.avg_ms != null ? st.avg_ms + "ms" : "—"}</td>
               <td class="mono">${escapeHtml(st.first_error || "")}</td>
             </tr>`
           )
           .join("")}
       </table>`
    : "";

  const shots = (s.screenshots || [])
    .map(
      (sh) => `<figure class="shot">
        <img src="data:image/jpeg;base64,${sh.jpeg_base64}" alt="Failure screenshot" />
        <figcaption>User ${sh.user}, step ${sh.step} (${escapeHtml(sh.label)}): ${escapeHtml(sh.error)}</figcaption>
      </figure>`
    )
    .join("");

  $("#report").innerHTML = `
    <div class="report-head">
      <h1>${escapeHtml(run.test_name || "Run")}</h1>
      <span class="pill ${run.status}">${run.status}</span>
      <!-- Engine named here as it is for HTTP runs (":903"). A report that omits which
           tool produced the measurement cannot be compared with another. Browser runs
           are always Playwright TODAY — script upload accepts only .jmx and .js
           (see app.js:567), so no user-supplied Playwright script can run. If Playwright
           upload ever lands (roadmap, needs sandboxing), this hardcoded label goes stale
           SILENTLY. Read it from a field then. Also unrecorded: a test converted from a
           Selenium .side file is indistinguishable from a hand-built one — no migration
           tracks the import. -->
      <span class="run-meta">browser · playwright · ${escapeHtml(run.browser || "chromium")} · ${run.virtual_users ?? "?"} user(s) × ${run.loops ?? 1} loop(s) · ${escapeHtml(hostOf(run.target_url))}</span>
      ${durationLine(run, run.summary)}
    </div>
    ${run.error ? `<p class="empty">Error: ${escapeHtml(run.error)}</p>` : ""}
    ${running ? progressPanel(run) : ""}
    <div class="metric-grid">
      ${m("Flows passed", s.flows_total != null ? `${s.flows_passed}/${s.flows_total}` : null)}
      ${m("Pass rate", s.pass_rate, "%", (s.pass_rate ?? 100) < 100)}
      ${m("Avg flow time", s.avg_flow_ms, "ms")}
      ${m("Slowest flow", s.max_flow_ms, "ms")}
    </div>
    ${stepsTable}
    ${shots ? `<h2>Failure screenshots</h2>${shots}` : ""}
    ${slaCard(s)}
    <div id="ai-slot"></div>
    ${exportCard(run)}
    ${run.companion_run_id ? `<div class="ai-card" style="border-left-color:var(--amber)">
      <span class="ai-eyebrow">Browser under load</span>
      <p>This flow ran while a background load test hammered the same target —
      compare these times against a run without load to see how user experience degrades.</p>
      <button class="btn" id="open-companion">Open the background load report →</button>
    </div>` : ""}`;
  if (run.companion_run_id)
    $("#open-companion")?.addEventListener("click", () => openReport(run.companion_run_id));
  wireExports(run);
  renderAi(run);
}

function renderAi(run) {
  const slot = $("#ai-slot");
  const a = run.ai_analysis;
  /* The run finished generating load but the analysis is still being written.
     Returning silently here leaves a BLANK SLOT on a report that looks complete. */
  if (run.status === "analyzing") {
    slot.innerHTML = `<div class="ai-card">
      <span class="ai-eyebrow">AI analysis</span>
      <p class="lede" style="margin:8px 0 0">Analysing the run…</p>
      <p class="hint" style="margin:6px 0 0">The metrics above are final. The analysis is still being written — this page updates itself.</p></div>`;
    return;
  }
  if (run.status !== "done") return;
  /* "Not available for this run." told the user nothing. The worker now STORES the
     reason on failure, so show it — and say plainly that the metrics are still
     trustworthy, because deriveVerdict computes the verdict from the run itself. */
  if (!a || a.skipped) {
    slot.innerHTML = `<div class="ai-card" style="border-left-color:var(--amber)">
      <span class="ai-eyebrow">AI analysis unavailable</span>
      <p class="lede" style="margin:8px 0 0">${
        a?.reason
          ? escapeHtml(a.reason) + " — add ANTHROPIC_API_KEY to .env to enable Claude analysis."
          : "The analysis did not run. Check ANTHROPIC_API_KEY and the worker logs."
      }</p>
      <p class="hint" style="margin:6px 0 0">The metrics above are unaffected — they are measured from the run itself.</p></div>`;
    return;
  }
  if (a.error) {
    slot.innerHTML = `<div class="ai-card" style="border-left-color:var(--coral)">
      <span class="ai-eyebrow">AI analysis failed</span>
      <p class="lede" style="margin:8px 0 0">${escapeHtml(a.error)}</p>
      <p class="hint" style="margin:6px 0 0">The metrics above are unaffected — they are measured from the run itself.</p></div>`;
    return;
  }
  slot.innerHTML = `
    <div class="ai-card">
      <span class="ai-eyebrow">AI analysis · Claude</span>
      <div class="verdict ${escapeHtml(a.verdict || "")}">${escapeHtml((a.verdict || "").toUpperCase())}
        <small style="font-size:13px;color:var(--ink-2);font-family:var(--mono)"> ${escapeHtml(
          { improving: "▲ improving", regressing: "▼ regressing", stable: "► stable", first_run: "● first run" }[a.trend] || ""
        )}</small></div>
      <p>${escapeHtml(a.headline || "")}</p>
      ${list("What went well", a.pros)}
      ${list("Concerns", a.cons)}
      ${list("Findings", a.findings)}
      ${list("Suspected causes", a.suspected_causes)}
      ${list("Recommendations", a.recommendations)}
    </div>`;
}
const list = (title, arr) =>
  arr?.length ? `<h2>${title}</h2><ul>${arr.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : "";


/* Live in-progress panel for running/queued runs (esp. long load tests). */
function progressPanel(run) {
  const dur = run.duration_secs || 0;
  const started = run.started_at ? new Date(run.started_at).getTime() : Date.now();
  const elapsed = run.status === "running" ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
  const pct = dur ? Math.min(99, Math.round((elapsed / dur) * 100)) : (run.status === "queued" ? 0 : 50);
  const label = run.status === "queued"
    ? "Queued — waiting for a worker to pick this up…"
    : run.test_type === "browser"
      ? "Browsers are clicking through your flow…"
      : `Running — ${elapsed}s${dur ? " of " + dur + "s" : ""} elapsed`;
  return `<div class="progress-panel">
    <div class="progress-row">
      <span class="spinner"></span>
      <span class="progress-label">${escapeHtml(label)}</span>
      ${dur ? `<span class="progress-pct">${pct}%</span>` : ""}
    </div>
    <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    <p class="hint" style="margin-top:8px">This page updates every few seconds — no need to refresh.</p>
  </div>`;
}

/* ————— Charts (vanilla canvas) ————— */
function drawChart(canvas, ts) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = 220;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const pad = { l: 44, r: 10, t: 10, b: 22 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const maxMs = Math.max(...ts.map((p) => p.ms), 1);
  const maxRps = Math.max(...ts.map((p) => p.rps), 1);
  const maxT = Math.max(...ts.map((p) => p.t), 1);
  const x = (t) => pad.l + (t / maxT) * iw;
  const yMs = (v) => pad.t + ih - (v / maxMs) * ih;
  const yRps = (v) => pad.t + ih - (v / maxRps) * ih;

  // gridlines
  ctx.strokeStyle = "#E2E8ED"; ctx.lineWidth = 1; ctx.font = "10px 'IBM Plex Mono'"; ctx.fillStyle = "#5A6B7A";
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ih / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillText(Math.round(maxMs * (1 - i / 4)) + "ms", 4, y + 3);
  }
  ctx.fillText("0s", pad.l, H - 6);
  ctx.fillText(maxT + "s", W - pad.r - 24, H - 6);

  const line = (color, yFn, key, width = 2) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    ts.forEach((p, i) => (i ? ctx.lineTo(x(p.t), yFn(p[key])) : ctx.moveTo(x(p.t), yFn(p[key]))));
    ctx.stroke();
  };
  line("#14A06B", yRps, "rps", 1.5);
  line("#1E5EFF", yMs, "ms", 2);
  // error markers
  ctx.fillStyle = "#FF4F30";
  ts.filter((p) => p.err > 0).forEach((p) => { ctx.beginPath(); ctx.arc(x(p.t), yMs(p.ms), 3, 0, 7); ctx.fill(); });
}

/* ————— Oscilloscope strip (signature) ————— */
const scope = $("#scope");
let scopeData = null, scopeAnim = null;
function setScopeIdle() {
  scopeData = null; $("#scope-label").textContent = "idle — waiting for signal"; drawScope();
}
function setScope(run) {
  if (run.timeseries?.length) {
    scopeData = run.timeseries.map((p) => p.ms);
    $("#scope-label").textContent =
      run.status === "done" ? `trace · ${run.test_name || "run"} · p95 ${run.summary?.p95_ms ?? "—"}ms` : "receiving…";
  } else {
    $("#scope-label").textContent =
      run.status === "running" ? "test running — trace incoming"
      : run.status === "done" ? `done · ${run.test_name || "run"}`
      : run.status === "failed" ? "run failed"
      : "queued";
    scopeData = null;
  }
  drawScope();
}
function drawScope() {
  const dpr = window.devicePixelRatio || 1;
  const W = scope.clientWidth || scope.parentElement.clientWidth, H = 56;
  scope.width = W * dpr; scope.height = H * dpr;
  const ctx = scope.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "#1E5EFF"; ctx.lineWidth = 1.5;
  ctx.shadowColor = "#1E5EFF"; ctx.shadowBlur = 6;
  ctx.beginPath();
  if (scopeData && scopeData.length > 1) {
    const max = Math.max(...scopeData, 1);
    scopeData.forEach((v, i) => {
      const px = (i / (scopeData.length - 1)) * W;
      const py = H - 8 - (v / max) * (H - 16);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
  } else {
    // idle flatline with a faint heartbeat
    const mid = H / 2;
    ctx.moveTo(0, mid);
    for (let px = 0; px < W; px += 2) {
      const blip = Math.sin(px / 18 + performance.now() / 600) * 2;
      ctx.lineTo(px, mid + blip);
    }
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cancelAnimationFrame(scopeAnim);
      scopeAnim = requestAnimationFrame(drawScope);
    }
  }
  ctx.stroke();
}
window.addEventListener("resize", drawScope);

function slaCard(s) {
  if (!s?.sla) return "";
  const ok = s.sla.passed;
  return `<div class="ai-card" style="border-left-color:${ok ? "var(--green)" : "var(--coral)"}">
    <span class="ai-eyebrow">SLA · CI/CD gate</span>
    <div class="verdict ${ok ? "pass" : "fail"}">${ok ? "SLA PASSED" : "SLA FAILED"}</div>
    <ul>${s.sla.checks.map((c) =>
      `<li><span style="color:${c.ok ? "var(--green)" : "var(--coral)"};font-weight:600">${c.ok ? "✓" : "✗"}</span>
       ${escapeHtml(c.name)} — actual <code>${escapeHtml(c.actual)}</code></li>`).join("")}</ul>
  </div>`;
}

/* ————— Report exports ————— */
function wireExports(run) {
  if (run.status !== "done") return;
  const status = $("#exp-status");
  const say = (msg, cls = "") => { status.hidden = false; status.textContent = msg; status.className = "hint " + cls; };

  $("#exp-pdf")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    say("Generating PDF — a real browser is printing your report…");
    try {
      const { id } = await api(`/runs/${run.id}/export/pdf`, { method: "POST" });
      const poll = setInterval(async () => {
        const ex = await api("/exports/" + id).catch(() => null);
        if (!ex) return;
        if (ex.status === "done") {
          clearInterval(poll); e.target.disabled = false;
          say("PDF ready — downloading.", "ok");
          window.location.href = "/api/exports/" + id + "/download";
        } else if (ex.status === "failed") {
          clearInterval(poll); e.target.disabled = false;
          say("PDF failed: " + (ex.error || "unknown error"), "err");
        }
      }, 2000);
    } catch (err) { e.target.disabled = false; say(err.message, "err"); }
  });

  $("#exp-email")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    say("Building HTML + PDF + PowerPoint and sending…");
    try {
      const to = $("#exp-email-to").value.trim();
      const { id, to: recipient } = await api(`/runs/${run.id}/export/email`, {
        method: "POST", body: JSON.stringify(to ? { to } : {}),
      });
      const poll = setInterval(async () => {
        const ex = await api("/exports/" + id).catch(() => null);
        if (!ex) return;
        if (ex.status === "done") { clearInterval(poll); e.target.disabled = false; say("Sent to " + recipient + " with all three files attached.", "ok"); }
        else if (ex.status === "failed") { clearInterval(poll); e.target.disabled = false; say("Email failed: " + (ex.error || "unknown"), "err"); }
      }, 2000);
    } catch (err) { e.target.disabled = false; say(err.message, "err"); }
  });
}

/* ————— utils ————— */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function hostOf(u) { try { return new URL(u).hostname; } catch { return ""; } }

/* boot */
setScopeIdle();

/* Baseline toggle — delegated so it works in BOTH report views (the export card
   markup is duplicated for load and browser reports). */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("#set-baseline");
  if (!btn) return;
  const isBaseline = btn.dataset.is === "1";
  const st = $("#baseline-status");
  btn.disabled = true;
  const markSet = (res) => {
    btn.dataset.is = "1";
    btn.textContent = "★ Baseline — click to clear";
    if (!st) return;
    st.textContent = res && res.warning
      ? "⚠ " + res.warning
      : "This run is now the baseline for future comparisons.";
    st.hidden = false;
  };

  try {
    if (isBaseline) {
      await api(`/runs/${btn.dataset.run}/baseline`, { method: "DELETE" });
      btn.dataset.is = "0";
      btn.textContent = "Set as baseline";
      if (st) { st.textContent = "Baseline cleared."; st.hidden = false; }
    } else {
      const res = await api(`/runs/${btn.dataset.run}/baseline`, { method: "POST" });
      markSet(res);
    }
  } catch (err) {
    /* The API refuses to baseline a saturated run — its numbers describe the generator,
       not the target. That refusal is NOT a dead end: offer the override, so setting a
       bad baseline stays possible but has to be a DELIBERATE act. */
    const saturated = /saturated/i.test(err.message || "");
    if (saturated && confirm(err.message + "\n\nSet it as the baseline anyway?")) {
      try {
        const res = await api(`/runs/${btn.dataset.run}/baseline`, {
          method: "POST",
          body: JSON.stringify({ force: true }),
        });
        markSet(res);
      } catch (err2) {
        if (st) { st.textContent = "Could not update baseline: " + err2.message; st.hidden = false; }
      }
    } else if (st) {
      st.textContent = "Could not update baseline: " + err.message;
      st.hidden = false;
    }
  } finally { btn.disabled = false; }
});

/* Stop a running test — delegated so it works in both report views. */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("#stop-run");
  if (!btn) return;
  const st = $("#stop-status");
  btn.disabled = true;
  try {
    const r = await api(`/runs/${btn.dataset.run}/cancel`, { method: "POST" });
    if (st) { st.textContent = r.status === "cancelled" ? "Stopped before it started." : "Stopping — the engine is flushing its results…"; st.hidden = false; }
    btn.textContent = "Stopping…";
  } catch (err) {
    if (st) { st.textContent = "Could not stop: " + err.message; st.hidden = false; }
    btn.disabled = false;
  }
});

/* ————— API-key bar —————
   Injected from JS so this fix touches ONE file. Shown automatically whenever
   the API answers 401/403, or if a key is already stored. In open mode it stays
   out of the way entirely. */
function showApiKeyBar(force) {
  let bar = document.getElementById("api-key-bar");

  if (!bar) {
    bar = document.createElement("div");
    bar.id = "api-key-bar";
    bar.style.cssText =
      "background:#FFF4E5;border-bottom:1px solid #E8960C;padding:10px 14px;" +
      "display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:14px";

    const label = document.createElement("label");
    label.textContent = "API key";
    label.style.cssText = "font-weight:600;color:#8a5a00";
    label.setAttribute("for", "api-key-input");

    const input = document.createElement("input");
    input.id = "api-key-input";
    input.type = "password";
    input.placeholder = "LOADSTAR_API_KEY from your .env";
    input.value = getApiKey();
    input.style.cssText = "flex:1;min-width:220px;padding:6px 8px;border:1px solid #E8960C;border-radius:6px";

    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save";
    save.style.cssText = "padding:6px 14px;border-radius:6px;border:1px solid #E8960C;background:#E8960C;color:#fff;cursor:pointer";
    save.onclick = () => {
      setApiKey(input.value.trim());
      location.reload();
    };

    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear";
    clear.style.cssText = "padding:6px 14px;border-radius:6px;border:1px solid #E8960C;background:#fff;color:#8a5a00;cursor:pointer";
    clear.onclick = () => {
      setApiKey("");
      location.reload();
    };

    const note = document.createElement("div");
    note.textContent =
      "Stored in this browser (localStorage). Anyone with this key has full access — " +
      "Loadstar has no per-user accounts yet. Leave LOADSTAR_API_KEY empty in .env to run without a key.";
    note.style.cssText = "flex-basis:100%;color:#8a5a00;font-size:12px;line-height:1.5";

    bar.append(label, input, save, clear, note);
    document.body.prepend(bar);
  }

  bar.hidden = !(force || getApiKey());
}

/* Show the bar on load if a key is already stored, so it is discoverable and
   clearable. In open mode with no key, nothing appears. */
document.addEventListener("DOMContentLoaded", () => showApiKeyBar(false));
