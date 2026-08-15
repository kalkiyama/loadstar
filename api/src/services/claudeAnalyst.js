import { loadProfile } from "../db.js";
import { filterSubSamples } from './subSampleFilter.mjs';
/**
 * AI results analysis via the Anthropic API.
 * Sends only aggregated metrics (never response bodies or credentials) to keep
 * customer payloads out of third-party calls — a deliberate security boundary.
 *
 * Requires ANTHROPIC_API_KEY in the environment. Fails soft: a run report is
 * still complete without AI analysis.
 */

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

/* The WHOLE summary goes into the prompt. per_endpoint is unbounded in principle
   (LABEL_CAP=200 in the worker guards MEMORY, not TOKENS), and a 200-row dump would
   blow the context and degrade every OTHER part of the analysis.

   So send what actually matters: every endpoint that ERRORED (never hide a broken
   route), plus the slowest by p95. And when we truncate, SAY SO in the data — a model
   that silently receives a partial list and reports on it as if complete is exactly the
   green-surface lie this whole feature exists to kill. */
const MAX_ENDPOINT_ROWS = 15;

function capEndpoints(summary) {
  /* Healthy sub-samples (redirect hops etc) go FIRST and UNCONDITIONALLY - the
     row cap below only fires above MAX_ENDPOINT_ROWS, but hops crowd out the
     bullet budget at ANY table size. Unhealthy hops survive: if a redirect
     starts 500ing, that hop is the finding. */
  const filtered = filterSubSamples(summary && summary.per_endpoint);
  if (filtered.dropped > 0) {
    summary = {
      ...summary,
      per_endpoint: filtered.rows,
      per_endpoint_subsamples_omitted:
        filtered.dropped + " healthy redirect/sub-request hop(s) were folded into their " +
        "parent endpoints and omitted here. They are NOT missing coverage and NOT a " +
        "vanished route - the user sees them in the report table. Analyse the parent " +
        "rows; you may still note that a parent's time includes a redirect chain.",
    };
  }
  const rows = summary && summary.per_endpoint;
  if (!Array.isArray(rows) || rows.length <= MAX_ENDPOINT_ROWS) return summary;

  const withErrors = rows.filter((r) => (r.errors || 0) > 0);
  const rest = rows.filter((r) => (r.errors || 0) === 0);
  const kept = [...withErrors];
  for (const r of rest) {
    if (kept.length >= MAX_ENDPOINT_ROWS) break;
    kept.push(r);
  }

  return {
    ...summary,
    per_endpoint: kept,
    per_endpoint_truncated:
      "Showing " + kept.length + " of " + rows.length + " endpoints: every endpoint with " +
      "errors, plus the slowest by p95. You have NOT seen them all — do not claim otherwise.",
  };
}

export async function analyzeRun({ test, summary, timeseries, history = [] }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { skipped: true, reason: "ANTHROPIC_API_KEY not set" };

  const isBrowser = summary?.test_type === "browser";
  const historyBlock = history.length
    ? `\nPrevious runs of this same test, newest first (compare current results against these):
${JSON.stringify(history, null, 2)}`
    : "\nThis is the first recorded run of this test — no history to compare against.";

  const prompt = `You are a senior QA/performance engineer reviewing a ${isBrowser ? "browser (functional/UI) test" : "load test"} result.


IMPORTANT — how to read the configuration:
- "virtual_users" is the number of simulated concurrent users. It is NOT a throughput target. Never describe throughput as reaching an rps target derived from the VU count.
- If "think_time" is present, each virtual user pauses after a request, so throughput is deliberately capped by simulated user behaviour, not by server capacity. Do not treat low rps as a bottleneck.
- 🔴 "first_byte" is TIME TO FIRST BYTE — and for a streaming response (an LLM API, an SSE feed, a large download) THE FIRST BYTE IS THE FIRST TOKEN. If first_byte.streaming_detected is true, THE p95/p99 LATENCY NUMBERS ARE NOT WHAT YOUR USERS FEEL. They describe when the response FINISHED. A 10-second LLM response that starts streaming at 200ms feels INSTANT; one that starts at 9s feels BROKEN — identical total latency, opposite experience. When streaming is detected, LEAD WITH first_byte.p95_ms, say plainly that total latency is the time to the LAST token, and do not present the total as user-facing latency. When streaming_detected is false, the response arrived in one piece and total latency IS the user experience — report it normally and do not mention this at all.
- 🔴 "measurement_trust" IS THE MOST IMPORTANT FIELD IN THIS PAYLOAD. Read it FIRST. If confidence is not "high", the THROUGHPUT NUMBER IS A FLOOR, NOT A CEILING, and you must not describe it as the target's capacity, ceiling, limit, or plateau. Say "at least N rps" and state why. Proven in this repo: nginx served 12,628 rps over loopback and only 3,214 rps across the Docker bridge — a 4x loss to VIRTUAL NETWORKING — while Loadstar reported the 3,214 as "the target's throughput ceiling" because the generator's CPU looked idle. Errors, status codes and assertions remain FULLY TRUSTWORTHY regardless: correctness does not care where the load came from. Be precise about which number is suspect; do not blanket-condemn the run.
- 🔴 "generator.saturated: false" DOES NOT MEAN THE NUMBERS ARE TRUSTWORTHY. It means the generator's CPU was not busy. Those are DIFFERENT QUESTIONS. A generator can be capped by the network, by sockets, by file descriptors, or by a virtual bridge while its CPU naps — all invisible to a CPU meter. NEVER write "the generator was not saturated, so these numbers reflect the target". That exact sentence was wrong in this repo, twice, and it is the reason this instruction exists.
- If throughput is FLAT across a wide range of virtual users while NOTHING is CPU-saturated, do not conclude "the target has reached its ceiling". A shared bottleneck BENEATH the generator — the network, the host, the virtualisation layer — produces exactly that signature. Say the throughput did not scale, say you cannot tell why from this data, and recommend running the generator on a separate machine from the target.
- "generator" reports the LOAD GENERATOR CONTAINER's own CPU usage during the test window (avg_load_ratio / peak_load_ratio = fraction of the generator's CPU capacity used, 0..1). "saturated" is true only when the generator was SUSTAINEDLY CPU-bound (average >= 0.85, or two or more consecutive samples >= 0.90) — a single brief spike, such as the JMeter JVM starting up, is NOT saturation and does not set the flag. If "saturated" is true, the GENERATOR was starved of CPU: requests queued inside the load tool rather than at the target, so latency is inflated and throughput plateaued for reasons that have NOTHING to do with the target. Do not diagnose the target as slow or overloaded when the generator was saturated — say the results are unreliable and recommend fewer virtual users or generators on separate machines. If "saturated" is false, the generator was NOT the bottleneck and you may read the latency and throughput numbers at face value. Runs recorded before this metric was fixed may show peak_load_ratio above 1.0 and lack a "metric" field — those older readings came from a 60-second load average that could not resolve a 15-30 second test, so treat their saturation flag as unreliable in BOTH directions.
- "per_endpoint" is a PER-ENDPOINT breakdown: one row per request label, each with requests, errors, error_rate, assertion counts, throughput_rps and avg/min/max/p50/p90/p95/p99. THIS IS OFTEN WHERE THE REAL ANSWER IS. A blended p95 can look healthy while ONE endpoint is catastrophically slow: four endpoints at 5ms and one at 2000ms average out to something that reads as fine. Do NOT stop at the aggregate. Name the guilty endpoint explicitly — "GET /checkout is the problem: p95 2100ms vs 4ms everywhere else" — rather than saying "some requests were slow". Likewise for errors: if error_rate is 33% overall but all of it belongs to one endpoint, say so, because that is a bug in one route, not a capacity problem. If the rows are all similar, say THAT too — a uniformly slow system is a different diagnosis from one bad route, and the distinction changes what the user should do next.
- SUB-REQUESTS: JMeter records each hop of a redirect chain as its own row named "<parent>-0", "<parent>-1". Healthy hops are folded into their parent before you see them, and a "_subsamples_omitted" note appears when that happened. Analyse the PARENT endpoints. An UNHEALTHY hop (errors, assertion failures, or a non-2xx/3xx status) is NOT filtered and will appear - if you see one, it is there because it is broken, so treat it as a real finding and name it. CRITICAL: hop rows present in "history" but absent from this run are NOT vanished routes and NOT lost coverage - they were filtered for being healthy. Never report a "-0"/"-1" row disappearing as a regression or a coverage loss.
- "per_endpoint" may be TRUNCATED (a "_truncated" note appears in the data when it is). It always includes every endpoint that had errors, plus the slowest by p95. If it is truncated, do not claim to have seen every endpoint.
- EXPECTED NON-2xx RESPONSES ARE NOT FAILURES. If a request declares assert.status (e.g. 404 for a not-found handler, 401 for an auth path, 429 for a rate limiter), then receiving that status is a PASS, not an error — Loadstar no longer counts it in "errors". So a test can show a 404 in status_codes with ZERO errors, and that is correct and healthy: it means someone deliberately tested a negative path and it behaved. Do not describe such an endpoint as broken. If instead you see a non-2xx status accompanied by ERRORS, that status was NOT expected, and it is a real failure. The presence of a 4xx/5xx in status_codes is therefore not sufficient to call something broken — check whether it produced errors.
- "status_codes" on each endpoint is the HTTP status distribution, e.g. {"200": 14629, "404": 14625}. USE IT — "33% errors" is not a diagnosis. 404 means a bad route or a missing path. 500 means a server bug. 503 means the target ran out of capacity, which IS a load finding. 401/403 means auth broke. 429 means the target rate-limited you, which means your load exceeded what it will accept rather than what it can serve. These are entirely different problems and demand different recommendations, so name the actual code rather than saying "errors". Also watch 3xx: a redirect is neither success nor failure, and a target that suddenly starts redirecting everything (e.g. to a login page) can show a clean 0% error rate while serving nothing useful.
- COMPARING ENDPOINTS AGAINST HISTORY: entries in "history" now carry their own "per_endpoint". Compare THIS run's endpoints against the BASELINE's endpoint-by-endpoint, by name. This is where regressions actually hide: one endpoint can double in latency while four fast ones hold steady and the BLENDED p95 barely moves. If you only compare aggregates you WILL call a real regression "stable" — do not.
- Treat an endpoint as REGRESSED if its p95 rose by at least 20% AND by at least 10ms, or if its error_rate rose at all, or if a non-2xx status code appeared that was not there before. Between 10% and 20% p95 growth, call it worth watching rather than a regression. Ignore sub-10ms absolute changes: on a fast target, 1ms of jitter is a "300% regression" and crying wolf is worse than silence.
- ENDPOINTS THAT APPEAR OR VANISH: if an endpoint is in the baseline but NOT in this run, SAY SO EXPLICITLY and prominently. It means that route stopped being tested — and it makes the blended numbers look BETTER while coverage silently shrank. That is a finding, not a footnote. Likewise, name any endpoint that is new in this run: it is not a regression, the test changed.
- "assertion_failures" / "assertion_total" report per-request response assertions (status/body content checks). Assertion failures are DISTINCT from "errors" (network/HTTP failures): a run with 0 errors but high assertion_failures means the server responded successfully but returned WRONG content — a correctness failure, not a capacity failure. Diagnose and describe these differently: correctness failures point to application bugs or bad deploys, not load limits.
- Before comparing against past runs, check whether their load profile (virtual_users, duration, think_time) matches. If it differs, state that the runs are not directly comparable on throughput rather than reporting a regression.
- "trend" covers CORRECTNESS as well as performance. If the baseline had no assertion failures and this run has them, the trend is "regressing" even when latency and throughput are unchanged — a correctness regression is still a regression. Report "stable" only when the run matches the baseline on BOTH correctness and performance.
- A history entry with "is_baseline": true is the user's KNOWN-GOOD reference run. Compare against it explicitly: has this run regressed relative to the baseline? Recent runs may ALL be degraded — if current and recent runs are similar but all worse than the baseline, that is a REGRESSION that has been stable, not a healthy "stable" trend. Never report "stable" merely because recent runs resemble each other; check them against the baseline first.
- A history entry with "pinned_comparison": true was explicitly chosen by the user (e.g. CI comparing a PR build against main). Give it prominence in the comparison.

Test configuration:
${JSON.stringify(
    isBrowser
      ? { users: test.virtual_users, loops: test.loops, steps: (test.browser_steps || []).length }
      : {
          mode: test.mode,
          virtual_users: test.virtual_users,
          ramp_up_secs: test.ramp_up_secs,
          duration_secs: test.duration_secs,
          method: test.method,
          ...loadProfile(test),
        },
    null,
    2
  )}

Aggregated results:
${JSON.stringify(capEndpoints(summary), null, 2)}
${
    isBrowser
      ? "\nNote: 'steps' shows each user action with pass/fail counts, average duration, and the first error seen. A failed step ends that user's flow."
      : `\nPer-second buckets (t = seconds from start, ms = avg response time, rps = requests/sec, err = errors):
${JSON.stringify(timeseries.slice(0, 300))}`
  }
${historyBlock}

Respond ONLY with a JSON object (no markdown fences, no preamble) with keys:
- "verdict": one of "pass" | "degraded" | "fail"
- "trend": one of "improving" | "regressing" | "stable" | "first_run" (based on the history)
- "headline": one plain-English sentence a manager could read
- "pros": array of 1-4 short strings — what is good in this run (include comparisons to history where relevant, with numbers)
- "cons": array of 0-4 short strings — what is bad or worse than before (with numbers)
- "findings": array of 2-5 short strings (bottlenecks, error patterns, latency trends, saturation points)
- "recommendations": array of 2-5 short, concrete next actions
- "suspected_causes": array of 0-3 strings (only if evidence supports them)`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      // The analysis JSON (verdict, trend, headline, pros, cons, findings,
      // recommendations, suspected_causes) routinely exceeds 1000 tokens, and a
      // truncated response is invalid JSON that gets silently discarded.
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    // THROW, do not return. The caller must be able to tell "the API is down" from
    // "the model said something odd" — one is infrastructure, one is a bad reply.
    const err = new Error(
      `Anthropic API ${res.status}` +
        (res.status === 401 ? " (bad or missing ANTHROPIC_API_KEY)" : "") +
        (res.status === 429 ? " (rate limited)" : "") +
        (res.status >= 500 ? " (Anthropic outage)" : "")
    );
    err.detail = detail.slice(0, 300);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = (data.content || [])
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .replace(/```json|```/g, "")
    .trim();
  try {
    // Models sometimes wrap JSON in a markdown fence or add a sentence before it.
    // Parse the raw text first; if that fails, extract the outermost { ... } block.
    try {
      return JSON.parse(text);
    } catch {
      const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      const candidate = fenced ? fenced[1] : text;
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start !== -1 && end > start) return JSON.parse(candidate.slice(start, end + 1));
      throw new Error("no JSON object found");
    }
  } catch {
    return { error: "Model returned non-JSON output", raw: text.slice(0, 500) };
  }
}
