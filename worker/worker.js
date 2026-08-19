/**
 * Loadstar worker — a single-node load generator.
 * Polls Postgres for queued runs, renders the JMX, shells out to JMeter,
 * parses the JTL results file, writes aggregates back, and requests AI analysis.
 *
 * Scaling path: replace the poll loop with a queue (SQS/NATS) and run N workers
 * on Kubernetes across regions — the geo-distributed story. This file's job
 * boundaries (claim → execute → aggregate) are already shaped for that.
 */
import { spawn } from "node:child_process";
import { markSubSamples, sortWithSubSamples } from './subsamples.mjs';
import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";
import dns from "node:dns/promises";
import path from "node:path";
import { pool } from "../api/src/db.js";
import { generateJmx } from "../api/src/services/jmxGenerator.js";
import { generateK6Script } from "../api/src/services/k6Generator.js";
import { makeHistogram, mergeHistograms } from "./histogram.js";
import { splitIntoShards, shouldDistribute, shardCountFor, resolveDistribution } from "./sharding.js";

/* Distribution thresholds: the operator decides, not us. DISTRIBUTION_VU_THRESHOLD is
   the VU count above which a test fans out; MAX_SHARDS caps how many generators it can
   use. Raising these without generators on separate machines means the generators
   contend for the same CPU and you measure your own hardware, not the target. */
const DIST_VU_THRESHOLD = Number(process.env.DISTRIBUTION_VU_THRESHOLD || 100);
const DIST_MAX_SHARDS = Number(process.env.MAX_SHARDS || 10);
import { evaluateSla } from "../api/src/services/sla.js";
import { analyzeRun } from "../api/src/services/claudeAnalyst.js";
import { notifyRunResult } from "../api/src/services/notify.js";
import { getRunHistory, sendRunEmail } from "../api/src/services/emailReport.js";
import { loadProfile } from "../api/src/db.js";

const JMETER_BIN = process.env.JMETER_BIN || "jmeter";
const POLL_MS = 3000;



async function claimNextRun() {
  // FOR UPDATE SKIP LOCKED = safe with many workers, no double execution.
  // This worker only executes JMeter (http) runs; browser runs belong to worker-browser.
  const q = await pool.query(`
    UPDATE runs SET status='running', started_at=now()
    WHERE id = (
      SELECT runs.id FROM runs JOIN tests ON tests.id = runs.test_id
      WHERE runs.status='queued' AND tests.test_type IN ('http','script')
      ORDER BY runs.created_at LIMIT 1 FOR UPDATE OF runs SKIP LOCKED
    )
    RETURNING *`);
  return q.rows[0] || null;
}

/** Poll for a cancel request while an engine subprocess runs, and SIGTERM it if
 *  asked. SIGTERM (not SIGKILL) so JMeter/k6 flush their result files — we keep the
 *  partial results. Returns a stop() to clear the poll when the run ends normally. */
/** Sample the generator machine's load while an engine runs.
 *
 *  A saturated generator produces numbers that describe the GENERATOR, not the target:
 *  requests queue in the load tool rather than at the server, latency inflates, and
 *  throughput plateaus — all of which look exactly like the target struggling. This is
 *  the single most misleading failure mode in load testing, and it gets more likely the
 *  more VUs and shards you allow.
 *
 *  loadavg is machine-wide (the container has no CPU quota), so it includes anything
 *  else on the box. That is still the right signal: if the machine is saturated, the
 *  generator is starved regardless of who else is competing for the CPU. The warning
 *  says "the generator machine", not "the generator process", because that is what we
 *  can honestly measure. */
/* The GENERATOR's own CPU — not the machine's.
 *
 * cgroup v2 exposes this container's cumulative CPU time at
 * /sys/fs/cgroup/cpu.stat. The worker container runs Node plus the JMeter/k6
 * subprocess and essentially nothing else, so the container's CPU usage IS the
 * generator's usage. Postgres, nginx, the API and the editor all fall away. */
function cgroupUsageUsec() {
  const txt = fs.readFileSync("/sys/fs/cgroup/cpu.stat", "utf8");
  const m = /^usage_usec\s+(\d+)/m.exec(txt);
  if (!m) throw new Error("cpu.stat has no usage_usec");
  return Number(m[1]);
}

/* If the container has a CPU quota (cpu.max = "QUOTA PERIOD"), that quota — not
 * the host core count — is the real denominator. "max" means no quota. */
function cgroupQuotaCores() {
  try {
    const [q, p] = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (q === "max") return null;
    const cores = Number(q) / Number(p);
    return Number.isFinite(cores) && cores > 0 ? cores : null;
  } catch {
    return null;
  }
}

/* Whole-machine fallback, for hosts without cgroup v2. Reported honestly in
 * `metric` so a machine-wide reading can never masquerade as a generator one. */
function procStatBusy() {
  const line = fs.readFileSync("/proc/stat", "utf8").split("\n")[0];
  const p = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (p[3] || 0) + (p[4] || 0);
  const total = p.reduce((a, b) => a + b, 0);
  return { idle, total };
}

/* WHY NOT os.loadavg(), AND WHY NOT THE WHOLE MACHINE:
 *
 *  1. loadavg[0] is a 60-SECOND average. Tests run 15-30s. A 60s window cannot
 *     measure a 15s event — it mostly reports what ran BEFORE. Two runs back to
 *     back and the second inherits the first. A 4.64 rps / 138-request run once
 *     reported saturated at 1.5x purely as the ghost of a 3,700 rps run before it.
 *
 *  2. Machine-wide is the wrong SUBJECT on a shared host. Measuring the box means
 *     measuring Docker, Postgres, nginx, the API and the editor. The same 140-request
 *     test ran three times and reported peak 0.86 / 0.91 / 0.94 — flipping the AI
 *     verdict between PASS and DEGRADED at random. 140 requests cannot saturate 2
 *     cores. We were measuring the box, not the test.
 *
 *  3. saturated must mean SUSTAINED. One 2-second sample — the JMeter JVM starting
 *     up — is not the generator failing to keep up. Requiring either a high average
 *     or two consecutive hot samples kills that false positive without hiding a
 *     genuinely pegged generator.
 *
 *  peak_load_ratio is still reported, for transparency. It just no longer votes
 *  alone. */
/* ============================================================================
 * MEASUREMENT TRUST — the thing no other load tester does.
 *
 * PROVEN in this repo, July 13:
 *   nginx over loopback ............ 12,628 rps
 *   Loadstar over the Docker bridge .. 3,214 rps
 * A 4x loss to VIRTUAL NETWORKING — and Loadstar reported the 3,214 as the
 * "target's throughput ceiling", certified by a flag that only watches CPU.
 *
 * The generator was at 47% CPU. The target at 18%. NOTHING was saturated, and
 * throughput would not move. CPU was never the bottleneck; the bridge was — and
 * a CPU meter CANNOT SEE A NETWORK.
 *
 * So we stop asking the generator how it feels, and instead ask a question it
 * cannot lie about: IS THE TARGET EVEN FAR ENOUGH AWAY TO MEASURE?
 * ========================================================================== */

/* Does the target sit on one of OUR OWN networks?
 *
 * Uses the interface's REAL netmask from os.networkInterfaces() — not a guessed
 * /16 or /24. Deterministic: if the target IP is inside our own subnet, the
 * generator and the target share a host and a virtual NIC, and the numbers
 * include BOTH of them. */
function targetSharesOurNetwork(targetIp) {
  const toInt = (ip) => ip.split(".").reduce((n, o) => ((n << 8) + Number(o)) >>> 0, 0);
  let t;
  try { t = toInt(targetIp); } catch { return null; }
  if (!Number.isFinite(t)) return null;

  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal || !a.cidr) continue;
      const bits = Number(a.cidr.split("/")[1]);
      if (!Number.isFinite(bits) || bits < 1 || bits > 32) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((toInt(a.address) & mask) === (t & mask)) {
        return { our_ip: a.address, our_cidr: a.cidr, target_ip: targetIp };
      }
    }
  }
  return null;
}

/* The UNLOADED latency floor. Measured BEFORE any load, with a single request.
 *
 * Two uses:
 *   1. loaded_p50 - idle_rtt = QUEUEING TIME. Wherever it happened.
 *   2. A sub-millisecond floor is a same-host fingerprint that ADDRESSING CANNOT
 *      HIDE — it catches co-location even behind a public IP or a k8s service.
 *
 * CALIBRATED, NOT GUESSED: the Docker bridge measures 0.9-2.2ms here. An earlier
 * draft used a 0.5ms threshold and would have MISSED THE EXACT CASE IT WAS BUILT
 * FOR. RTT alone cannot separate "bridge" (~1ms) from "real LAN" (0.5-2ms) —
 * they overlap. It is a corroborating signal, not a verdict. */
async function measureLatencyFloor(targetUrl) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    try {
      const res = await fetch(targetUrl, { method: "GET", signal: AbortSignal.timeout(5000) });
      await res.arrayBuffer();
    } catch {
      continue;
    }
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  return +samples[Math.floor(samples.length / 2)].toFixed(3);
}

/* Assemble the trust verdict. PRECISE, not blanket.
 *
 * Co-location invalidates THROUGHPUT. It does NOT invalidate errors, status codes
 * or assertions — correctness does not care where the load came from. A banner that
 * cries wolf on every local test is ignored within a week, and then it protects
 * nobody. Say exactly which number is untrustworthy, and why. */
async function assessMeasurementTrust(targetUrl) {
  let host;
  try { host = new URL(targetUrl).hostname; } catch { return null; }

  let ip = null;
  try {
    const r = await dns.lookup(host, { family: 4 });
    ip = r.address;
  } catch { /* unresolvable — say nothing rather than guess */ }

  const colocated = ip ? targetSharesOurNetwork(ip) : null;
  const floor_ms = await measureLatencyFloor(targetUrl);

  const reasons = [];
  let confidence = "high";

  if (colocated) {
    confidence = "low";
    reasons.push(
      "The generator (" + colocated.our_ip + ") and the target (" + colocated.target_ip +
      ") are on the SAME network (" + colocated.our_cidr + "). They share a host, a CPU " +
      "and a virtual NIC. Measured here: nginx serves 12,628 rps over loopback but only " +
      "3,214 rps across the Docker bridge \u2014 a 4x loss to virtual networking. " +
      "THROUGHPUT IS A FLOOR, NOT A CEILING."
    );
  }

  if (floor_ms !== null && floor_ms < 3 && !colocated) {
    confidence = confidence === "high" ? "medium" : confidence;
    reasons.push(
      "Unloaded round-trip to the target is " + floor_ms + "ms. Real networks are slower " +
      "than this; the target may be on the same host despite its address."
    );
  }

  return {
    confidence,
    target_ip: ip,
    colocated: !!colocated,
    latency_floor_ms: floor_ms,
    throughput_is: confidence === "high" ? "a measurement" : "a FLOOR, not a ceiling",
    trustworthy: {
      errors: true,
      status_codes: true,
      assertions: true,
      latency: confidence === "high",
      throughput: confidence === "high",
    },
    reasons,
  };
}

function watchLoad() {
  const hostCores = Math.max(1, os.cpus().length);
  let useCgroup = true;
  let cores = cgroupQuotaCores() || hostCores;

  let prevU = null;
  let prevT = null;
  let prevStat = null;

  try {
    prevU = cgroupUsageUsec();
    prevT = Date.now();
  } catch {
    useCgroup = false;
    cores = hostCores;
    try { prevStat = procStatBusy(); } catch { prevStat = null; }
  }

  const samples = [];

  const iv = setInterval(() => {
    try {
      if (useCgroup) {
        const u = cgroupUsageUsec();
        const t = Date.now();
        const dU = u - prevU;
        const dT = (t - prevT) * 1000;
        prevU = u;
        prevT = t;
        if (dT <= 0) return;
        samples.push(Math.min(1, Math.max(0, dU / (dT * cores))));
      } else {
        if (!prevStat) return;
        const now = procStatBusy();
        const dTotal = now.total - prevStat.total;
        const dIdle = now.idle - prevStat.idle;
        prevStat = now;
        if (dTotal <= 0) return;
        samples.push(Math.min(1, Math.max(0, (dTotal - dIdle) / dTotal)));
      }
    } catch {
      /* a transient read failure must not kill the run */
    }
  }, 2000);

  return () => {
    clearInterval(iv);
    if (!samples.length) return null;

    const peak = Math.max(...samples);
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;

    // Longest run of CONSECUTIVE samples at or above 0.90.
    let streak = 0;
    let longest = 0;
    for (const s of samples) {
      streak = s >= 0.9 ? streak + 1 : 0;
      if (streak > longest) longest = streak;
    }

    return {
      cores: +cores.toFixed(2),
      avg_load_ratio: +avg.toFixed(2),
      peak_load_ratio: +peak.toFixed(2),
      sustained_hot_samples: longest,
      saturated: avg >= 0.85 || longest >= 2,
      metric: useCgroup ? "generator_cgroup_cpu" : "host_cpu_fallback",
    };
  };
}
function watchForCancel(runId, proc) {
  if (!runId) return () => {};
  const iv = setInterval(async () => {
    try {
      const q = await pool.query("SELECT cancel_requested FROM runs WHERE id=$1", [runId]);
      if (q.rows[0]?.cancel_requested) {
        console.log(`[worker] run ${runId}: cancel requested — stopping engine`);
        proc.kill("SIGTERM");
        clearInterval(iv);
      }
    } catch { /* transient DB blip: retry next tick */ }
  }, 2000);
  return () => clearInterval(iv);
}

function runJmeter(jmxPath, jtlPath, runId) {
  return new Promise((resolve, reject) => {
    /* failureMessage is the ONLY honest way to tell an assertion failure from a
       network error: JMeter populates it when an assertion fails and leaves it empty
       on a plain HTTP/network failure. Set explicitly rather than trusting the
       container's default jmeter.properties — assuming a default is how three bugs
       happened today. */
    const args = [
      "-n", "-t", jmxPath, "-l", jtlPath,
      "-Jjmeter.save.saveservice.output_format=csv",
      "-Jjmeter.save.saveservice.assertion_results_failure_message=true",
    ];
    const p = spawn(JMETER_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stopWatch = watchForCancel(runId, p);
    let stderr = "";
    p.stdout.on("data", (d) => process.stdout.write(`[jmeter] ${d}`));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (err) => { stopWatch(); reject(err); });
    p.on("close", (code) => {
      stopWatch();
      // A cancelled run is SIGTERMed: exit code is non-zero but this is not a crash.
      if (code === 0 || code === 143 || code === null) return resolve();
      reject(new Error(`JMeter exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/* ————— k6 engine ————— */

const K6_BIN = process.env.K6_BIN || "k6";

function runK6(scriptPath, ndjsonPath, debug = false, runId = null) {
  return new Promise((resolve, reject) => {
    const args = debug
      ? ["run", "--out", `json=${ndjsonPath}`, scriptPath]
      : ["run", "--out", `json=${ndjsonPath}`, "--quiet", scriptPath];
    const p = spawn(K6_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stopWatch = watchForCancel(runId, p);
    let stderr = "", stdout = "";
    p.stdout.on("data", (d) => { stdout += d; process.stdout.write(`[k6] ${d}`); });
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (err) => { stopWatch(); reject(err); });
    // k6 exits 99 when thresholds fail — that's still a completed run for us.
    // Return both streams combined: k6 sends console.log (our __TRACE__ markers) to stderr.
    p.on("close", (code) => {
      stopWatch();
      // 99 = thresholds failed (still a completed run). 143/null = SIGTERM from cancel.
      // 99 = thresholds failed. 105 = k6 aborted by signal (our cancel). 143/null = POSIX SIGTERM.
      if (code === 0 || code === 99 || code === 105 || code === 143 || code === null) return resolve(stdout + "\n" + stderr);
      reject(new Error(`k6 exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

// Parse __TRACE__ / __CAPTURED__ markers from k6 output. k6 wraps console.log as:
//   level=info msg="__TRACE__{escaped json}" source=console
// so we extract the quoted msg, unescape it, then JSON.parse the part after the marker.
function parseDebugTrace(output) {
  const trace = [], captured = [];
  for (const raw of (output || "").split("\n")) {
    if (!raw.includes("__TRACE__") && !raw.includes("__CAPTURED__")) continue;
    let payload = raw;
    const m = raw.match(/msg="((?:[^"\\]|\\.)*)"/);
    if (m) payload = m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    const after = (marker) => {
      const mi = payload.indexOf(marker);
      return mi === -1 ? null : payload.slice(mi + marker.length);
    };
    if (payload.includes("__TRACE__")) { const j = after("__TRACE__"); if (j) { try { trace.push(JSON.parse(j)); } catch {} } }
    else if (payload.includes("__CAPTURED__")) { const j = after("__CAPTURED__"); if (j) { try { captured.push(JSON.parse(j)); } catch {} } }
  }
  for (const t of trace) {
    if (t.extract) { const c = captured.find((c) => c.var === t.extract); if (c) t.extractedValue = c.value; }
  }
  return trace;
}


/** Read a file line-by-line via a stream, calling fn(line) — constant memory. */
async function forEachLine(filePath, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) fn(line);
}

/** Parse k6's NDJSON output into the same summary/timeseries shape as JMeter.
 *  Streams the file and uses a histogram, so a million-request run stays light. */
/* A REAL CSV line parser. Replaces `line.split(",")`.
 *
 * The old comment said "MVP: labels with commas need a CSV lib later". Later is
 * NOW: the label was previously IGNORED, so a comma inside it was harmless. The
 * moment the label becomes a GROUPING KEY, a comma shifts every column after it
 * and silently forges a phantom endpoint — surfacing as a mysterious extra row
 * rather than as an error. JMeter quotes such fields ("GET /a,b"), so honour the
 * quotes. */
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }  // escaped quote ""
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/* Per-endpoint accumulator. One histogram per label.
 *
 * Memory: each histogram is an Int32Array(60001) = 240KB in-process. Ten
 * endpoints = 2.4MB. Fine. The thing that would NOT have been fine is the wire
 * format — hence the sparse snapshot in histogram.js.
 *
 * LABEL_CAP exists because a per-endpoint table is only useful if the labels are
 * STABLE. Both generators emit an explicit static label (`req.name` or
 * "METHOD /path"), so cardinality is bounded by the test definition. But an
 * UPLOADED script is user-written and can label per-iteration — which would
 * produce thousands of one-request "endpoints" and eat memory. Cap it, and say
 * so out loud rather than silently truncating. */
const LABEL_CAP = 200;

/* TIME TO FIRST BYTE, and whether TOTAL LATENCY IS LYING TO YOU.
 *
 * A 10-second response that starts streaming at 200ms FEELS INSTANT.
 * A 10-second response that starts streaming at 9s FEELS BROKEN.
 * Identical total latency. Opposite user experience. Every load tester on earth
 * reports the first number and calls it "latency".
 *
 * STREAMING IS DETECTED, NOT GUESSED. We do not sniff the URL for "looks like an
 * LLM API" — we measure the ratio:
 *
 *     ttfb / total > 0.9  -> the whole response landed at once. Total latency IS
 *                            the user experience. Nothing to warn about.
 *     ttfb / total < 0.5  -> the response STARTED long before it FINISHED. Total
 *                            latency is NOT what the user feels.
 *
 * Engine-agnostic and guess-free. It also catches a large file download, which has
 * the identical signature and the identical misreporting problem. */
function firstByteBlock(ttfbHist, totalHist) {
  if (!ttfbHist || !ttfbHist.count) return null;

  const p50 = ttfbHist.percentile(50);
  const p95 = ttfbHist.percentile(95);
  const totalP95 = totalHist.percentile(95);

  // Guard against a zero total (a target so fast the whole thing rounds to 0ms).
  const ratio = totalP95 > 0 ? +(p95 / totalP95).toFixed(3) : 1;
  const streaming = ratio < 0.5 && totalP95 >= 50;

  const out = {
    avg_ms: ttfbHist.avg,
    p50_ms: p50,
    p90_ms: ttfbHist.percentile(90),
    p95_ms: p95,
    p99_ms: ttfbHist.percentile(99),
    max_ms: ttfbHist.max,
    // How much of the total wait happened BEFORE the first byte arrived.
    ttfb_to_total_ratio: ratio,
    streaming_detected: streaming,
  };

  if (streaming) {
    out.warning =
      "This endpoint STREAMS. p95 total latency is " + totalP95 + "ms, but the response " +
      "STARTS ARRIVING at " + p95 + "ms. For a streaming API (an LLM, an SSE feed, a large " +
      "download) the user experiences the FIRST byte, not the last. Do NOT report " +
      totalP95 + "ms as user-facing latency \u2014 it is the time to the LAST token.";
  }

  return out;
}

function makeEndpointTable() {
  const byLabel = new Map();
  let capped = false;

  return {
    add(label, ms, isError, assertTotal, assertFail, bytes, statusCode) {
      const key = label && String(label).trim();
      // No label -> we cannot attribute this sample. Drop it rather than
      // conjuring a phantom endpoint. (k6 `checks` points carry no name tag.)
      if (!key) return;
      let e = byLabel.get(key);
      if (!e) {
        if (byLabel.size >= LABEL_CAP) { capped = true; return; }
        e = {
          hist: makeHistogram(),
          errors: 0,
          assertion_total: 0,
          assertion_failures: 0,
          bytes: 0,
          // "33% errors" is not a diagnosis. 404 (bad route), 500 (server bug),
          // 503 (out of capacity) and 401 (auth broken) are FOUR different
          // problems, and the code was being read and thrown away.
          codes: new Map(),
        };
        byLabel.set(key, e);
      }
      if (Number.isFinite(ms)) e.hist.add(ms);
      if (isError) e.errors++;
      e.assertion_total += assertTotal || 0;
      e.assertion_failures += assertFail || 0;
      e.bytes += bytes || 0;
      if (Number.isFinite(statusCode) && statusCode > 0) {
        e.codes.set(statusCode, (e.codes.get(statusCode) || 0) + 1);
      }
    },

    /* One row per endpoint, slowest p95 first — because the whole point is that
       the slow endpoint should not be able to hide inside a healthy average. */
    finish(wallSecs) {
      const rows = [...byLabel.entries()].map(([name, e]) => {
        const n = e.hist.count;
        return {
          name,
          requests: n,
          errors: e.errors,
          error_rate: n ? +((e.errors / n) * 100).toFixed(2) : 0,
          assertion_total: e.assertion_total,
          assertion_failures: e.assertion_failures,
          throughput_rps: +(n / Math.max(1, wallSecs)).toFixed(2),
          avg_ms: e.hist.avg,
          min_ms: e.hist.min,
          max_ms: e.hist.max,
          p50_ms: e.hist.percentile(50),
          p90_ms: e.hist.percentile(90),
          p95_ms: e.hist.percentile(95),
          p99_ms: e.hist.percentile(99),
          total_kb: Math.round(e.bytes / 1024),
          /* The sparse histogram, per endpoint. WITHOUT THIS the controller cannot
             merge percentiles across shards — and averaging p95s is the classic
             wrong answer that the whole exact-bin design exists to avoid. */
          hist: e.hist.snapshot(),
          // { "200": 14629, "404": 14625 } — sorted, most common first.
          status_codes: Object.fromEntries(
            [...e.codes.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => [String(c), n])
          ),
        };
      });
      const real = rows.filter((r) => r.requests > 0);
      /* Label JMeter sub-samples (redirect hops et al) BEFORE sorting, then sort
         parents by p95 DESC and tuck each parent's sub-samples beneath it. */
      markSubSamples(real);
      const ordered = sortWithSubSamples(real);
      rows.length = 0;
      rows.push(...ordered);
      if (capped) {
        rows.push({
          name: "(truncated: more than " + LABEL_CAP + " distinct labels)",
          requests: 0, errors: 0, error_rate: 0,
          assertion_total: 0, assertion_failures: 0, throughput_rps: 0,
          avg_ms: 0, min_ms: 0, max_ms: 0,
          p50_ms: 0, p90_ms: 0, p95_ms: 0, p99_ms: 0, total_kb: 0,
        });
      }
      return rows;
    },

    /* Sparse per-endpoint histograms, so a distributed run can merge them
       exactly — the same reason the overall histogram is merged by bin. */
    snapshot() {
      const out = {};
      for (const [name, e] of byLabel) {
        out[name] = {
          hist: e.hist.snapshot(),
          errors: e.errors,
          assertion_total: e.assertion_total,
          assertion_failures: e.assertion_failures,
          bytes: e.bytes,
        };
      }
      return out;
    },
  };
}

async function parseK6(ndjsonPath) {
  const hist = makeHistogram();
  /* TIME TO FIRST BYTE. k6 has emitted http_req_waiting on every request since
     forever, and parseK6 threw it away. For a STREAMING response the first byte
     is the FIRST TOKEN — so this is time-to-first-token, and it is the number a
     user actually feels. Total latency describes when the response FINISHED. */
  const ttfbHist = makeHistogram();
  const buckets = new Map(); // second -> {count, errs, sumMs}
  const endpoints = makeEndpointTable();
  let errors = 0, bytes = 0, t0 = Infinity, t1 = 0, assertionFails = 0, assertionTotal = 0;

  await forEachLine(ndjsonPath, (line) => {
    if (!line) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (obj.type !== "Point") return;
    const ts = Date.parse(obj.data.time);
    // k6Generator already sets  tags: { name: req.name }  — an EXPLICIT static
    // label, NOT the rendered URL. That is what keeps ${var} chaining and CSV
    // parameterisation from exploding into thousands of one-request endpoints.
    const label = (obj.data.tags && obj.data.tags.name) || null;
    // k6 tags every http metric with the status. It was there all along.
    const code = obj.data.tags ? parseInt(obj.data.tags.status, 10) : NaN;

    if (obj.metric === "http_req_duration") {
      const ms = obj.data.value;
      hist.add(ms);
      endpoints.add(label, ms, false, 0, 0, 0, code);
      t0 = Math.min(t0, ts); t1 = Math.max(t1, ts);
      const sec = Math.floor(ts / 1000);
      const b = buckets.get(sec) || { count: 0, errs: 0, sumMs: 0 };
      b.count++; b.sumMs += ms;
      buckets.set(sec, b);
    } else if (obj.metric === "http_req_failed" && obj.data.value === 1) {
      /* If the request ASSERTED a status, the ASSERTION is the verdict — the check
         metric already records the failure. Counting it here too would report ONE
         event TWICE: 100% errors AND 100% assertion failures on the same run.

         And it would be the WRONG verdict. The server ANSWERED — it was not down,
         not timing out, not refusing connections. It answered WRONGLY. That is a
         CORRECTNESS failure, not a CAPACITY failure, and error_rate is what SLA
         gates and capacity alarms fire on. JMeter already gets this right; k6 only
         disagreed because it has two independent verdicts where JMeter has one. */
      const asserted = !!(obj.data.tags && obj.data.tags.asserted === "true");
      if (asserted) return;

      errors++;
      endpoints.add(label, NaN, true, 0, 0, 0, code);
      const sec = Math.floor(ts / 1000);
      const b = buckets.get(sec) || { count: 0, errs: 0, sumMs: 0 };
      b.errs++; buckets.set(sec, b);
    } else if (obj.metric === "checks") {
      assertionTotal++;
      const failed = obj.data.value === 0;
      if (failed) assertionFails++;
      endpoints.add(label, NaN, false, 1, failed ? 1 : 0, 0);
    } else if (obj.metric === "http_req_waiting") {
      /* TIME TO FIRST BYTE. k6 has emitted this on every request forever and
         parseK6 threw it away. For a STREAMING response the first byte is the
         FIRST TOKEN — the number a user actually feels. */
      ttfbHist.add(obj.data.value);
    } else if (obj.metric === "data_received") {
      bytes += obj.data.value;
    }
  });

  const total = hist.count;
  const wallSecs = Math.max(1, (t1 - t0) / 1000);
  const firstSec = Math.floor(t0 / 1000);
  const timeseries = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sec, b]) => ({
      t: sec - firstSec,
      rps: b.count,
      ms: b.count ? Math.round(b.sumMs / b.count) : 0,
      err: b.errs,
    }));

  return {
    summary: {
      engine: "k6",
      total_requests: total,
      errors,
      error_rate: total ? +((errors / total) * 100).toFixed(2) : 0,
      assertion_failures: assertionFails,
      assertion_total: assertionTotal,
      throughput_rps: +(total / wallSecs).toFixed(2),
      avg_ms: hist.avg,
      min_ms: hist.min,
      max_ms: hist.max,
      p50_ms: hist.percentile(50),
      p90_ms: hist.percentile(90),
      p95_ms: hist.percentile(95),
      p99_ms: hist.percentile(99),
      total_kb: Math.round(bytes / 1024),
      wall_seconds: Math.round(wallSecs),
      first_byte: firstByteBlock(ttfbHist, hist),
      // The whole point: a slow endpoint must not hide inside a healthy
      // blended average. Sorted slowest-p95 first.
      per_endpoint: endpoints.finish(wallSecs),
    },
    timeseries,
    hist,
    endpoints,
  };
}

/** Parse JMeter CSV JTL into summary + per-second timeseries.
 *  Streams the file with a histogram so huge result sets stay memory-safe. */
async function parseJtl(jtlPath, hasAssertions = false) {
  let header = null, iTs, iEl, iOk, iBytes, iCode, iLabel, iFailMsg, iLatency;
  const hist = makeHistogram();
  /* JMeter writes a `Latency` column (time to FIRST byte) in its default CSV set —
     right next to `failureMessage`, which we already read. parseJtl has never
     indexed it. For a streaming response, first byte = FIRST TOKEN. */
  const ttfbHist = makeHistogram();
  const buckets = new Map(); // second -> { count, errs, sumMs }
  const endpoints = makeEndpointTable();
  let errors = 0, bytes = 0, t0 = Infinity, t1 = 0, assertionFails = 0, assertionTotal = 0;

  await forEachLine(jtlPath, (line) => {
    if (!line) return;
    if (!header) {
      header = parseCsvLine(line);
      iTs = header.indexOf("timeStamp"); iEl = header.indexOf("elapsed");
      iOk = header.indexOf("success"); iBytes = header.indexOf("bytes");
      iCode = header.indexOf("responseCode");
      // The label was sitting in the header all along and was never indexed.
      // jmxGenerator sets testname per sampler, so it is a real endpoint name.
      iLabel = header.indexOf("label");
      // The discriminator between "assertion failed" and "network error".
      iFailMsg = header.indexOf("failureMessage");
      // Time to FIRST byte. It was in the header all along.
      iLatency = header.indexOf("Latency");
      return;
    }
    const c = parseCsvLine(line); // quoted-aware — a comma in a label used to shift every column
    const ts = Number(c[iTs]), ms = Number(c[iEl]);
    if (!Number.isFinite(ts) || !Number.isFinite(ms)) return;
    const ok = c[iOk] === "true";
    // JMeter marks a sample failed for BOTH network errors and assertion
    // failures. Split them: a 2xx/3xx responseCode with success=false means the
    // request completed but an assertion failed (content wrong, server healthy).
    const code = iCode >= 0 ? parseInt(c[iCode], 10) : NaN;

    /* WAS: `completed = code >= 200 && code < 400`, i.e. "an assertion failure can
       only happen on a 2xx/3xx". That was TRUE until expected-status shipped, and is
       now FALSE: a status assertion can fail ON a 4xx. Classifying by status code
       would count it as a NETWORK ERROR — collapsing the very distinction Loadstar
       exists to make ("the server is broken" vs "it answered, wrongly").

       failureMessage is JMeter's own signal: populated when an ASSERTION fails, empty
       on a plain HTTP/network failure. Read the signal; do not infer it. */
    const failMsg = iFailMsg >= 0 ? (c[iFailMsg] || "").trim() : "";
    const assertionFailed = failMsg.length > 0;

    let isError = false, aTotal = 0, aFail = 0;
    if (!ok && assertionFailed) { assertionTotal++; assertionFails++; aTotal = 1; aFail = 1; }
    else if (!ok) { errors++; isError = true; }
    else if (ok && hasAssertions) { assertionTotal++; aTotal = 1; }

    const rowBytes = Number(c[iBytes]) || 0;
    bytes += rowBytes;
    hist.add(ms);

    /* JMeter Latency = time to FIRST byte. It was in the header all along and
       parseJtl never indexed it. */
    if (iLatency >= 0) {
      const lat = Number(c[iLatency]);
      if (Number.isFinite(lat) && lat >= 0) ttfbHist.add(lat);
    }

    const label = iLabel >= 0 ? c[iLabel] : null;
    // `code` is ALREADY parsed above — it was used as a boolean and thrown away.
    endpoints.add(label, ms, isError, aTotal, aFail, rowBytes, code);
    t0 = Math.min(t0, ts); t1 = Math.max(t1, ts);
    const sec = Math.floor(ts / 1000);
    const b = buckets.get(sec) || { count: 0, errs: 0, sumMs: 0 };
    b.count++; b.sumMs += ms; if (!ok) b.errs++;
    buckets.set(sec, b);
  });

  const total = hist.count;
  const wallSecs = Math.max(1, (t1 - t0) / 1000);
  const firstSec = Math.floor(t0 / 1000);

  const timeseries = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sec, b]) => ({
      t: sec - firstSec,
      rps: b.count,
      ms: b.count ? Math.round(b.sumMs / b.count) : 0,
      err: b.errs,
    }));

  return {
    summary: {
      total_requests: total,
      errors,
      error_rate: total ? +((errors / total) * 100).toFixed(2) : 0,
      assertion_failures: assertionFails,
      assertion_total: assertionTotal,
      first_byte: firstByteBlock(ttfbHist, hist),
      per_endpoint: endpoints.finish(wallSecs),
      throughput_rps: +(total / wallSecs).toFixed(2),
      avg_ms: hist.avg,
      min_ms: hist.min,
      max_ms: hist.max,
      p50_ms: hist.percentile(50),
      p90_ms: hist.percentile(90),
      p95_ms: hist.percentile(95),
      p99_ms: hist.percentile(99),
      total_kb: Math.round(bytes / 1024),
      wall_seconds: Math.round(wallSecs),
    },
    timeseries,
    hist,
  };
}

/**
 * CONTROLLER (distributed run). 3c-i: spawn shard rows only. The poll loop and
 * merge are added in 3c-ii. For now it fans out and leaves the parent marked
 * 'coordinating' so we can verify the fan-out in isolation.
 */
/* ============================================================================
 * WORKER HEARTBEAT — so the controller can COUNT ITS GENERATORS.
 *
 * Loadstar had no idea how many workers existed. It would happily create 2 shard
 * rows with 1 worker running, then block for 153 seconds waiting for shards that
 * nobody could claim — because the ONLY worker was the one doing the waiting.
 * ========================================================================== */
const WORKER_ID = os.hostname();
const HEARTBEAT_MS = 5000;
const WORKER_STALE_MS = 15000;   // 3 missed beats = gone

async function beat() {
  try {
    await pool.query(
      "INSERT INTO workers (id, kind, last_seen) VALUES ($1, 'http', now()) " +
        "ON CONFLICT (id) DO UPDATE SET last_seen = now()",
      [WORKER_ID]
    );
  } catch (e) {
    // A missed beat must never kill the worker. Worst case the controller
    // under-counts and REFUSES a run — which is the safe direction to fail.
    console.warn(`[worker] heartbeat failed: ${e.message}`);
  }
}

async function liveWorkerCount() {
  const q = await pool.query(
    "SELECT count(*)::int AS n FROM workers WHERE kind='http' AND last_seen > now() - ($1 || ' milliseconds')::interval",
    [String(WORKER_STALE_MS)]
  );
  return (q.rows[0] && q.rows[0].n) || 0;
}

/* Started HERE, below beat() and HEARTBEAT_MS. It was at the top of the file,
   ~700 lines above these declarations, and `const` is not hoisted: the worker
   crash-looped on boot with a ReferenceError and vanished from `docker ps`.
   node --check passed it, because a temporal-dead-zone error is valid syntax. */
beat().catch(() => {});
const heartbeatTimer = setInterval(() => { beat().catch(() => {}); }, HEARTBEAT_MS);
heartbeatTimer.unref?.();

async function runAsController(run, t) {
  const n = resolveDistribution(t, DIST_VU_THRESHOLD, DIST_MAX_SHARDS).shards;

  /* PRE-FLIGHT. Refuse in under a second instead of deadlocking for 153.

     The controller BLOCKS while coordinating (see the poll loop below), so it
     cannot also execute a shard. N shards therefore need N+1 workers. With fewer,
     the shard rows get created and nobody is left to claim them — and the run dies
     of a timeout whose message ("timeout: 0/2 shards done") names no cause.

     Fail-closed on a counting error: if we cannot count workers we do NOT shard.
     A refused run is recoverable; a 153-second deadlock is just lost time. */
  let live = 0;
  try {
    live = await liveWorkerCount();
  } catch (e) {
    console.warn(`[worker] could not count workers: ${e.message}`);
  }
  const executors = Math.max(0, live - 1); // the controller cannot execute a shard

  if (executors < n) {
    const need = n + 1;
    const msg =
      `Not enough generators. This test needs ${n} shards, which requires ${need} ` +
      `workers (${n} to run the shards + 1 to coordinate — the coordinator cannot ` +
      `also execute). ${live} ${live === 1 ? "is" : "are"} running.\n\n` +
      `Either:\n` +
      `  docker compose up -d --scale worker=${need}\n` +
      `or set the test's distribution mode to "off" to run all ${t.virtual_users} ` +
      `virtual users on a single generator.\n\n` +
      `(Note: ${t.virtual_users} VUs on one generator may saturate it — check ` +
      `measurement_trust in the results.)`;

    console.error(`[worker] REFUSING run ${run.id}: ${msg.replace(/\n/g, " ")}`);
    await pool.query(
      "UPDATE runs SET status='failed', finished_at=now(), error=$1 WHERE id=$2",
      [msg, run.id]
    );
    return;
  }

  const shards = splitIntoShards(t.virtual_users, n);
  console.log(`[worker] CONTROLLER run ${run.id}: ${t.virtual_users}vu → ${n} shards (${live} workers live)`);
  for (const sh of shards) {
    await pool.query(
      "INSERT INTO runs (test_id, status, shard_of, shard_index, shard_count) VALUES ($1,'queued',$2,$3,$4)",
      [run.test_id, run.id, sh.shard_index, sh.shard_count]
    );
  }
  await pool.query("UPDATE runs SET status='coordinating', started_at=now() WHERE id=$1", [run.id]);
  console.log(`[worker] CONTROLLER run ${run.id}: spawned ${shards.length} shards, coordinating`);

  // 3c-ii: block until all shards finish, any fail, or we time out. The
  // controller-worker is busy coordinating during this (accepted for D1).
  // NOTE: if the controller itself dies mid-poll, the parent is left
  // 'coordinating' — an orphaned-parent sweep is a D2 concern, not handled here.
  const deadlineMs = Date.now() + (t.duration_secs + (t.ramp_up_secs || 0) + 120) * 1000;
  for (;;) {
    const r = await pool.query("SELECT status FROM runs WHERE shard_of = $1", [run.id]);
    const rows = r.rows;
    const failed = rows.filter((x) => x.status === "failed").length;
    const done = rows.filter((x) => x.status === "done").length;

    if (failed > 0) {
      await pool.query(
        "UPDATE runs SET status='failed', finished_at=now(), error=$1 WHERE id=$2",
        [failed + " of " + rows.length + " shards failed", run.id]
      );
      console.log(`[worker] CONTROLLER ${run.id}: ${failed} shard(s) failed → run failed`);
      return;
    }
    if (rows.length > 0 && done === rows.length) {
      // 3c-iii: merge shard snapshots (exact percentiles) + additive counts.
      const sr = await pool.query(
        "SELECT shard_snapshot, summary, timeseries FROM runs WHERE shard_of=$1 ORDER BY shard_index",
        [run.id]
      );
      const snaps = sr.rows.map((x) => x.shard_snapshot).filter(Boolean);
      const merged = mergeHistograms(snaps);

      // Counts/errors/throughput are NOT in the histogram — sum them from each
      // shard's own summary (they are additive; shards ran concurrently so we
      // sum rps rather than dividing by wall time).
      let totalErrors = 0, totalRps = 0, totalKb = 0, wall = 0;
      for (const x of sr.rows) {
        const su = x.summary || {};
        totalErrors += Number(su.errors) || 0;
        totalRps += Number(su.throughput_rps) || 0;
        totalKb += Number(su.total_kb) || 0;
        wall = Math.max(wall, Number(su.wall_seconds) || 0);
      }
      const totalReq = merged.count;


      // Per-second chart: sum rps + errors across shards; request-weighted ms
      // (the chart line is approximate — the SUMMARY percentiles above are exact).
      const bySec = new Map();
      for (const x of sr.rows) {
        for (const p of (x.timeseries || [])) {
          const b = bySec.get(p.t) || { t: p.t, rps: 0, err: 0, _msw: 0, _n: 0 };
          b.rps += p.rps || 0;
          b.err += p.err || 0;
          b._msw += (p.ms || 0) * (p.rps || 0);
          b._n += p.rps || 0;
          bySec.set(p.t, b);
        }
      }
      const timeseries = [...bySec.values()]
        .sort((a, b) => a.t - b.t)
        .map((b) => ({ t: b.t, rps: b.rps, err: b.err, ms: b._n ? Math.round(b._msw / b._n) : 0 }));

      // Worst generator across the shards. One saturated generator is enough to make
      // the merged numbers describe the GENERATORS rather than the target.
      let worstGen = null;
      for (const x of sr.rows) {
        const g = (x.summary || {}).generator;
        if (!g) continue;
        if (!worstGen || (g.peak_load_ratio || 0) > (worstGen.peak_load_ratio || 0)) worstGen = g;
      }

      const summary = {
        engine: t.engine,
        total_requests: totalReq,
        errors: totalErrors,
        error_rate: totalReq ? +((totalErrors / totalReq) * 100).toFixed(2) : 0,
        throughput_rps: +totalRps.toFixed(2),
        avg_ms: merged.avg_ms,
        min_ms: merged.min_ms,
        max_ms: merged.max_ms,
        p50_ms: merged.p50_ms,
        p90_ms: merged.p90_ms,
        p95_ms: merged.p95_ms,
        p99_ms: merged.p99_ms,
        total_kb: totalKb,
        wall_seconds: wall,
        distributed: true,
        shards: sr.rows.length,
        generator: worstGen,
      };

      /* THE SHARDS MEASURED THESE AND THE MERGE THREW THEM AWAY.

         measurement_trust: every shard runs the co-location probe (its log fires),
         and then the controller builds a fresh summary and drops it. So the runs
         MOST likely to mislead — the big distributed ones — were the ONLY ones with
         no trust assessment at all. Any shard's reading is authoritative: they all
         hit the same target from the same host. */
      for (const x of sr.rows) {
        const mt = (x.summary || {}).measurement_trust;
        if (mt) { summary.measurement_trust = mt; break; }
      }

      /* per_endpoint: NOT a copy. Each shard has its OWN histogram per endpoint, and
         PERCENTILES CANNOT BE AVERAGED — that is the whole reason mergeHistograms
         merges by BIN, and the whole reason the sparse snapshot carries `hist` per
         endpoint. Merge them properly or do not merge them at all. */
      const epByName = new Map();
      for (const x of sr.rows) {
        for (const e of ((x.summary || {}).per_endpoint || [])) {
          const cur = epByName.get(e.name) || {
            name: e.name, requests: 0, errors: 0,
            assertion_total: 0, assertion_failures: 0, total_kb: 0,
            codes: {}, hists: [],
          };
          cur.requests += e.requests || 0;
          cur.errors += e.errors || 0;
          cur.assertion_total += e.assertion_total || 0;
          cur.assertion_failures += e.assertion_failures || 0;
          cur.total_kb += e.total_kb || 0;
          for (const [code, n] of Object.entries(e.status_codes || {})) {
            cur.codes[code] = (cur.codes[code] || 0) + n;
          }
          if (e.hist) cur.hists.push(e.hist);
          epByName.set(e.name, cur);
        }
      }

      if (epByName.size) {
        const rows = [...epByName.values()].map((e) => {
          // Exact bin merge. Averaging p95s across shards is the classic wrong answer.
          const h = e.hists.length ? mergeHistograms(e.hists) : null;
          return {
            name: e.name,
            requests: e.requests,
            errors: e.errors,
            error_rate: e.requests ? +((e.errors / e.requests) * 100).toFixed(2) : 0,
            assertion_total: e.assertion_total,
            assertion_failures: e.assertion_failures,
            throughput_rps: +(e.requests / Math.max(1, wall)).toFixed(2),
            avg_ms: h ? h.avg_ms : 0,
            min_ms: h ? h.min_ms : 0,
            max_ms: h ? h.max_ms : 0,
            p50_ms: h ? h.p50_ms : 0,
            p90_ms: h ? h.p90_ms : 0,
            p95_ms: h ? h.p95_ms : 0,
            p99_ms: h ? h.p99_ms : 0,
            total_kb: e.total_kb,
            status_codes: Object.fromEntries(
              Object.entries(e.codes).sort((a, b) => b[1] - a[1])
            ),
          };
        });
        /* The merge REBUILDS every row from the shard snapshots, so sub-sample
           flags must be re-derived here - they cannot survive that round trip.
           Same function as the single-worker path: one implementation, never a copy. */
        markSubSamples(rows);
        summary.per_endpoint = sortWithSubSamples(rows);
      }

      const sla = evaluateSla(t.sla, summary);
      if (sla) summary.sla = sla;
      /* NOT `done` yet. The AI analysis takes ~30s on a run this size, and the UI
         polls until it sees a terminal status and then STOPS. Marking `done` here
         made the UI render "The analysis did not run" for a run whose analysis was
         about to land — the database had it, the screen denied it.

         This is the SAME RACE that fooled my own verify script yesterday. I fixed
         the script and left the bug in the product. `analyzing` closes it: the run
         is not finished until it IS finished. */
      await pool.query(
        "UPDATE runs SET status='analyzing', finished_at=now(), summary=$1, timeseries=$2, sla_passed=$3, profile=$4 WHERE id=$5",
        [JSON.stringify(summary), JSON.stringify(timeseries), sla ? sla.passed : null, JSON.stringify(loadProfile(t)), run.id]
      );
      console.log(`[worker] CONTROLLER ${run.id}: merged ${sr.rows.length} shards → ${totalReq} reqs, p95 ${summary.p95_ms}ms`);

      // AI + email, once, on the merged result (fail-soft)
      /* SPLIT, deliberately. Analysis failure and email failure are DIFFERENT
         events and used to log the identical line — a working analysis with a
         broken SMTP config was indistinguishable from the AI never running.

         And on failure we now STORE the reason. Previously the reason lived only
         in a console.warn nobody reads, ai_analysis stayed NULL, and the exported
         report rendered "Run complete." — confidently silent about the fact that
         the headline feature had not run at all. */
      let analysis = null;
      let history = [];
      try {
        history = await getRunHistory(t.id, run.id, 5, run.compare_to);
        analysis = await analyzeRun({ test: t, summary, timeseries, history });
        await pool.query("UPDATE runs SET ai_analysis=$1 WHERE id=$2", [JSON.stringify(analysis), run.id]);
      } catch (e) {
        console.error(`[worker] AI ANALYSIS FAILED for run ${run.id}: ${e.message}`);
        analysis = { error: e.message, failed_at: new Date().toISOString() };
        await pool
          .query("UPDATE runs SET ai_analysis=$1 WHERE id=$2", [JSON.stringify(analysis), run.id])
          .catch(() => {});
      }
      try {
        await sendRunEmail({ test: t, run, summary, analysis, history });
      } catch (e) {
        console.warn(`[worker] email skipped for run ${run.id}: ${e.message}`);
      }
      /* NOW it is done. Everything the report needs is in the database. */
      await pool.query("UPDATE runs SET status='done' WHERE id=$1", [run.id]);
      await notifyRunResult(pool, t, { ...run, status: "done" }, summary).catch(() => {});
      return;
    }
    if (Date.now() > deadlineMs) {
      await pool.query(
        "UPDATE runs SET status='failed', finished_at=now(), error=$1 WHERE id=$2",
        ["timeout: " + done + "/" + rows.length + " shards done", run.id]
      );
      console.log(`[worker] CONTROLLER ${run.id}: TIMEOUT (${done}/${rows.length} done)`);
      return;
    }
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
}

async function processRun(run) {
  const t = (await pool.query("SELECT * FROM tests WHERE id=$1", [run.test_id])).rows[0];
  // CONTROLLER PATH: a non-shard run big enough to distribute fans out into
  // shard rows (claimed by other workers) and coordinates their results. It
  // runs no load itself. Reuses the proven generator path for every shard.
  if (!run.shard_of && resolveDistribution(t, DIST_VU_THRESHOLD, DIST_MAX_SHARDS).distribute) {
    return runAsController(run, t);
  }
  // GENERATOR PATH (distributed run): a shard runs only its VU slice. Override
  // the VU count before the script is generated; everything else runs normally.
  if (run.shard_of) {
    const parts = splitIntoShards(t.virtual_users, run.shard_count);
    const slice = parts[run.shard_index];
    if (slice) t.virtual_users = slice.virtual_users;
    console.log(`[worker] shard ${run.shard_index + 1}/${run.shard_count} of ${run.shard_of}: ${t.virtual_users}vu`);
  }
  /* Measured BEFORE the load starts — an unloaded target, so the floor is clean. */
  const measurementTrust = await assessMeasurementTrust(t.target_url).catch(() => null);
  if (measurementTrust && measurementTrust.confidence !== "high") {
    console.warn(
      "[worker] MEASUREMENT TRUST: " + measurementTrust.confidence + " \u2014 " +
      measurementTrust.reasons.join(" ")
    );
  }

  const stopLoad = watchLoad();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loadstar-"));
  const jmxPath = path.join(dir, "plan.jmx");
  const jtlPath = path.join(dir, "results.jtl");
  try {
    let result;
    let k6Stdout = null;
    if (t.engine === "k6") {
      const scriptPath = path.join(dir, "script.js");
      const ndjsonPath = path.join(dir, "results.ndjson");
      t.debug = run.debug === true;
      fs.writeFileSync(scriptPath, t.uploaded_script || generateK6Script(t));
      console.log(`[worker] run ${run.id} (k6): ${t.mode} / ${t.virtual_users}vu / ${t.duration_secs}s → ${t.target_url}`);
      k6Stdout = await runK6(scriptPath, ndjsonPath, run.debug === true, run.id);
      result = await parseK6(ndjsonPath);
    } else {
      let csvPath;
      if (t.csv_data) {
        csvPath = path.join(dir, "data.csv");
        fs.writeFileSync(csvPath, t.csv_data);
      }
      const jmxPath2 = jmxPath;
      fs.writeFileSync(jmxPath2, t.uploaded_script || generateJmx(t, { csvPath }));
      console.log(`[worker] run ${run.id} (jmeter): ${t.mode} / ${t.virtual_users}vu / ${t.duration_secs}s → ${t.target_url}`);
      await runJmeter(jmxPath2, jtlPath, run.id);
      const hasAsserts = Array.isArray(t.requests) && t.requests.some((r) => r && r.assert);
      result = await parseJtl(jtlPath, hasAsserts);
    }
    const { summary, timeseries } = result;
    if (t.script_warnings) summary.script_warnings = t.script_warnings;

    // Was the GENERATOR the bottleneck rather than the target? A saturated generator
    // inflates latency and plateaus throughput in a way that looks exactly like the
    // target struggling — the most misleading failure mode in load testing.
    const gen = stopLoad();
    /* The single most important field in the payload. Without this line the whole
       feature is dead code that passes its own tests. */
    if (measurementTrust) summary.measurement_trust = measurementTrust;
    if (gen) {
      summary.generator = gen;
      if (gen.saturated) {
        console.warn(`[worker] run ${run.id}: GENERATOR SATURATED (peak load ${gen.peak_load_ratio}x ${gen.cores} cores) — results may reflect generator limits, not target capacity`);
      }
    }

    // CANCELLED: the engine was SIGTERMed mid-run. Keep the partial results (real
    // data), but mark the run 'cancelled' so it is never mistaken for a complete run.
    // No AI analysis or email — a truncated run would produce a misleading verdict,
    // and nobody wants a "your test failed" email for a test they stopped themselves.
    // getRunHistory only selects status IN ('done','failed'), so cancelled runs are
    // automatically excluded from comparisons and cannot become a baseline.
    {
      const c = await pool.query("SELECT cancel_requested FROM runs WHERE id=$1", [run.id]);
      if (c.rows[0]?.cancel_requested) {
        summary.cancelled = true;
        await pool.query(
          "UPDATE runs SET status='cancelled', finished_at=now(), summary=$1, timeseries=$2, error=$3 WHERE id=$4",
          [JSON.stringify(summary), JSON.stringify(timeseries), "Stopped by user — partial results", run.id]
        );
        console.log(`[worker] run ${run.id} cancelled: ${summary.total_requests} reqs before stop`);
        return;
      }
    }

    // SLA gate for CI/CD
    const sla = evaluateSla(t.sla, summary);
    if (sla) summary.sla = sla;
    if (run.debug === true && typeof k6Stdout === "string") {
      const trace = parseDebugTrace(k6Stdout);
      await pool.query("UPDATE runs SET debug_trace=$1 WHERE id=$2", [JSON.stringify(trace), run.id]);
      console.log(`[worker] debug trace captured: ${trace.length} requests`);
    }
    // GENERATOR completion: a shard reports its raw histogram for the controller
    // to merge, plus its own summary for forensics. No AI/email/SLA — those run
    // once, on the controller's merged result. Return before the normal path.
    if (run.shard_of) {
      await pool.query(
        "UPDATE runs SET status='done', finished_at=now(), summary=$1, timeseries=$2, shard_snapshot=$3 WHERE id=$4",
        [JSON.stringify(summary), JSON.stringify(timeseries), JSON.stringify(result.hist.snapshot()), run.id]
      );
      console.log(`[worker] shard ${run.shard_index + 1}/${run.shard_count} done: ${summary.total_requests} reqs`);
      return;
    }
    await pool.query(
      /* `analyzing`, NOT `done` — the distributed path at the shard-merge call
         site already does this and the single-generator path did not. Marking a
         run done before ai_analysis is written opens a window (the whole length
         of the Claude call) where the report page stops polling, sees done with
         a null analysis, and prints "The analysis did not run" about an analysis
         that is running. The real transition to done happens after the analysis
         is stored, below. */
      "UPDATE runs SET status='analyzing', finished_at=now(), summary=$1, timeseries=$2, sla_passed=$3, profile=$4 WHERE id=$5",
      [JSON.stringify(summary), JSON.stringify(timeseries), sla ? sla.passed : null, JSON.stringify(loadProfile(t)), run.id]
    );
    // AI analysis with run history, then email report — both fail-soft
    /* Split — see the note at the distributed call site. Analysis failure and
       email failure are different events, and the reason must be STORED, not
       whispered to a log nobody reads. */
    let analysis = null;
    let history = [];
    try {
      history = await getRunHistory(t.id, run.id, 5, run.compare_to);
      analysis = await analyzeRun({ test: t, summary, timeseries, history });
      await pool.query("UPDATE runs SET ai_analysis=$1 WHERE id=$2", [JSON.stringify(analysis), run.id]);
    } catch (e) {
      console.error(`[worker] AI ANALYSIS FAILED for run ${run.id}: ${e.message}`);
      analysis = { error: e.message, failed_at: new Date().toISOString() };
      await pool
        .query("UPDATE runs SET ai_analysis=$1 WHERE id=$2", [JSON.stringify(analysis), run.id])
        .catch(() => {});
    }
    try {
      await sendRunEmail({ test: t, run, summary, analysis, history });
    } catch (e) {
      console.warn(`[worker] email skipped for run ${run.id}: ${e.message}`);
    }
    await pool.query("UPDATE runs SET status='done' WHERE id=$1", [run.id]);
    await notifyRunResult(pool, t, { ...run, status: "done" }, summary).catch(() => {});
    console.log(`[worker] run ${run.id} done: ${summary.total_requests} reqs, p95 ${summary.p95_ms}ms`);
  } catch (e) {
    stopLoad();
    // Was this a user-requested stop rather than a crash? The engine's exit code is
    // unreliable for this (k6 exits 105 on SIGTERM, not the POSIX 143), so check our
    // own flag — it is authoritative.
    const c = await pool.query("SELECT cancel_requested FROM runs WHERE id=$1", [run.id]).catch(() => null);
    if (c?.rows[0]?.cancel_requested) {
      await pool.query(
        "UPDATE runs SET status='cancelled', finished_at=now(), error=$1 WHERE id=$2",
        ["Stopped by user", run.id]
      );
      console.log(`[worker] run ${run.id} cancelled by user`);
      return;
    }
    console.error(`[worker] run ${run.id} failed:`, e.message);
    await pool.query("UPDATE runs SET status='failed', finished_at=now(), error=$1 WHERE id=$2", [
      e.message.slice(0, 1000),
      run.id,
    ]);
    await notifyRunResult(pool, t, { ...run, status: "failed", error: e.message }, null).catch(() => {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function loop() {
  console.log("[worker] Loadstar worker started, polling for runs…");
  for (;;) {
    try {
      const run = await claimNextRun();
      if (run) await processRun(run);
      else await new Promise((r) => setTimeout(r, POLL_MS));
    } catch (e) {
      console.error("[worker] loop error:", e.message);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}
loop();
