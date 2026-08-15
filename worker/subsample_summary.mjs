/**
 * Collapse support for the per-endpoint table.
 *
 * WHY: labelling sub-samples fixed the "one url reads as three endpoints" lie,
 * but ten endpoints each with a redirect chain is a THIRTY row table, twenty
 * rows of which are noise for the question the table exists to answer ("which
 * endpoint is slow?"). So sub-samples collapse by default in the UI.
 *
 * THE RULE WE MUST NOT BREAK: we chose to LABEL rather than FOLD precisely so a
 * redirect's real latency cost stays visible. Collapsing rows would quietly undo
 * that - unless the collapsed parent still SAYS what is underneath it. Hence
 * this summary: it carries the count and, crucially, the redirect time, so the
 * cost survives collapse as a number instead of as rows.
 *
 * Exports (HTML/PDF) render EVERYTHING expanded: a static document that hides
 * data behind a control which does not exist is a document with missing data.
 */
export function subSampleSummary(parent, rows) {
  if (!parent || !Array.isArray(rows)) return null;
  const kids = rows.filter((r) => r && r.sub_sample && r.sub_of === parent.name);
  if (!kids.length) return null;
  const hops = kids.filter((r) => r.redirect_hop);
  /* avg_ms, not p95: these get SUMMED across hops to describe one journey, and
     summing p95s from different samples is the same category error as averaging
     percentiles - the thing this codebase refuses to do anywhere else. */
  const redirectMs = hops.reduce((n, r) => n + (Number(r.avg_ms) || 0), 0);
  const parts = [kids.length + " sub-request" + (kids.length === 1 ? "" : "s")];
  if (hops.length && redirectMs > 0) {
    parts.push(fmtSubMs(redirectMs) + " in redirect" + (hops.length === 1 ? "" : "s"));
  }
  return {
    count: kids.length,
    redirect_count: hops.length,
    redirect_ms: Math.round(redirectMs),
    text: parts.join(" \u00b7 "),
  };
}

export function fmtSubMs(ms) {
  const n = Number(ms) || 0;
  return n >= 1000 ? +(n / 1000).toFixed(1) + "s" : Math.round(n) + "ms";
}
