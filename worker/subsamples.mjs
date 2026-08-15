/**
 * Sub-sample detection, shared by the single-worker endpoint table and the
 * distributed shard merge. ONE implementation, two call sites - a copy in each
 * would be the verify_ssrf drift bug all over again.
 *
 * WHY THIS EXISTS: JMeter's follow_redirects records EVERY hop of a redirect
 * chain as its own TOP-LEVEL sample, named "<parent>-0", "<parent>-1", ... So a
 * test with ONE url produced THREE rows in the per-endpoint table, which reads
 * as three endpoints and is simply false. (Observed live against a site whose
 * apex 301s to https://www - the author of this tool lost twenty minutes to it,
 * so a first-time user has no chance.) The numbers were right; the presentation
 * lied about what they were.
 *
 * WE LABEL, WE DO NOT FOLD. Folding sub-samples into the parent would hide the
 * redirect's cost, and that cost is real user-facing latency - precisely the
 * kind of thing this tool exists to surface. A sub-sample keeps every metric it
 * had; it just stops pretending to be an independent endpoint.
 *
 * THE RULE: a row is a sub-sample when its name matches <parent>-<digits> AND
 * that parent is itself a row in the same table. Suffixed labels under an
 * existing parent are how JMeter emits sub-samples. Sub-samples whose status
 * codes are ALL 3xx are further marked as REDIRECT hops - the nameable case.
 *
 * KNOWN LIMIT, ACCEPTED: this is a heuristic on labels, not a parent link (flat
 * CSV JTL carries no nesting). A user who genuinely names two endpoints
 * "checkout" and "checkout-0" gets the latter labelled a sub-request. The row
 * and all its numbers stay fully visible, so the cost of being wrong is a wrong
 * label, never lost data.
 */
export function markSubSamples(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return rows;
  const names = new Set(rows.map((r) => r && r.name));
  for (const r of rows) {
    if (!r || typeof r.name !== "string") continue;
    const m = /^(.+)-(\d+)$/.exec(r.name);
    if (!m) continue;
    const parent = m[1];
    if (!names.has(parent)) continue;
    r.sub_sample = true;
    r.sub_of = parent;
    r.sub_index = Number(m[2]);
    const codes = Object.keys(r.status_codes || {});
    r.redirect_hop =
      codes.length > 0 && codes.every((c) => Number(c) >= 300 && Number(c) < 400);
  }
  return rows;
}

/**
 * Sort parents by p95 DESC - the existing rule, kept deliberately: a slow
 * endpoint must not be able to hide inside a healthy blended average. Each
 * parent's sub-samples then sit directly beneath it in sample order. ONLY
 * sub-sample rows move.
 */
export function sortWithSubSamples(rows) {
  if (!Array.isArray(rows)) return rows;
  const kidsByParent = new Map();
  const parents = [];
  for (const r of rows) {
    if (r && r.sub_sample) {
      const list = kidsByParent.get(r.sub_of) || [];
      list.push(r);
      kidsByParent.set(r.sub_of, list);
    } else {
      parents.push(r);
    }
  }
  parents.sort((a, b) => (b.p95_ms - a.p95_ms) || (b.requests - a.requests));
  const out = [];
  for (const p of parents) {
    out.push(p);
    const kids = kidsByParent.get(p && p.name);
    if (kids) {
      kids.sort((a, b) => a.sub_index - b.sub_index);
      out.push(...kids);
      kidsByParent.delete(p.name);
    }
  }
  /* Orphans (parent truncated by LABEL_CAP, say) must never silently vanish -
     dropping a row is a worse bug than mislabelling one. */
  for (const list of kidsByParent.values()) out.push(...list);
  return out;
}
