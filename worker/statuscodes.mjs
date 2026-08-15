/**
 * Run-level HTTP status roll-up for the report.
 *
 * The per-endpoint rows already carry status_codes; this sums them into one
 * distribution for the whole run, because "what did the target actually answer"
 * is a question about the RUN, and answering it per-endpoint makes the reader do
 * the addition themselves.
 *
 * THE HONEST PART: a status roll-up counts RESPONSES. A network failure -
 * connection refused, timeout, reset - produces NO status code at all. A run
 * against a dead target would therefore show a near-empty strip beside a 100%
 * error rate, which reads as "everything answered fine" to a skimming eye. So
 * when total_requests exceeds the sum of coded responses, the difference is
 * reported explicitly as "no response". Silence is not a 200.
 */
export function statusRollup(summary) {
  const rows = (summary && summary.per_endpoint) || [];
  const counts = new Map();
  let coded = 0;
  for (const r of rows) {
    /* Sub-samples are hops of a parent request, and their codes are REAL
       responses the target sent - a 301 hop genuinely happened. Count them. */
    for (const [code, n] of Object.entries((r && r.status_codes) || {})) {
      const c = Number(code);
      if (!Number.isFinite(c) || c <= 0) continue;
      const k = Number(n) || 0;
      counts.set(c, (counts.get(c) || 0) + k);
      coded += k;
    }
  }
  if (!counts.size && !coded) return null;
  const total = Number(summary && summary.total_requests) || 0;
  const out = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([code, count]) => ({ code, count, klass: statusClass(code) }));
  const missing = total - coded;
  if (missing > 0) {
    out.push({ code: 0, count: missing, klass: "none", label: "no response" });
  }
  return { codes: out, coded, total };
}

export function statusClass(code) {
  if (code >= 500) return "s5";
  if (code >= 400) return "s4";
  if (code >= 300) return "s3";
  if (code >= 200) return "s2";
  return "other";
}
