/**
 * Drop HEALTHY sub-samples from the analysis payload.
 *
 * WHY: JMeter emits every redirect hop as its own row (see worker/subsamples.mjs).
 * Ten endpoints with redirect chains is a thirty-row payload, twenty rows of which
 * are hops that moved together and tell one story. The model's bullet budget is
 * fixed, so those rows do not add detail — they CROWD OUT the endpoints that matter.
 * Tonight's proof: a three-row run spent three of four "Concerns" bullets narrating
 * hops that all regressed identically.
 *
 * WHAT WE KEEP: a hop stays when it is UNHEALTHY — it has errors, assertion
 * failures, or any status code outside 2xx/3xx. If a redirect starts 500ing, that
 * hop IS the finding and must never be filtered away.
 *
 * WHAT THIS IS NOT: the report table still shows every row (collapsed, expandable)
 * and the HTML export shows them all expanded. This filter narrows what the ANALYSIS
 * reasons over, not what the user can see.
 */
export function filterSubSamples(rows) {
  if (!Array.isArray(rows)) return { rows, dropped: 0 };
  const out = [];
  let dropped = 0;
  for (const r of rows) {
    if (!r || !r.sub_sample) { out.push(r); continue; }
    const codes = Object.keys(r.status_codes || {}).map(Number);
    const unhealthy =
      (r.errors || 0) > 0 ||
      (r.assertion_failures || 0) > 0 ||
      codes.some((c) => c < 200 || c >= 400);
    if (unhealthy) out.push(r);
    else dropped++;
  }
  return { rows: out, dropped };
}
