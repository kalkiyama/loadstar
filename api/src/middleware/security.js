import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { isPrivateAddress } from "../lib/ssrfGuard.js";

// Re-exported so existing importers (targetVerification.js, notify.js) are
// unaffected. The implementation itself lives in lib/ssrfGuard.js — a
// dependency-free module that verify_ssrf.mjs also imports directly, so the
// verify script and the running app can never drift apart again.
export { isPrivateAddress };

// Loadstar is normally self-hosted over PLAIN HTTP (localhost, a LAN box, a
// Codespace port). Helmet's defaults assume a TLS deployment and, merged in
// silently, break exactly that case:
//   - upgrade-insecure-requests: browsers re-request app.js/styles.css over
//     https://, which the server does not speak. Safari and Chromium show an
//     SSL error and render an unstyled, inert page. Firefox exempts localhost,
//     which is why this went unnoticed.
//   - HSTS (max-age 1 year, includeSubDomains): pins the ORIGIN, not the app.
//     On localhost that poisons every other local dev server on the machine
//     for a year, long after Loadstar is gone.
// Both are therefore opt-in via LOADSTAR_BEHIND_TLS=true, for deployments
// actually terminating TLS at a reverse proxy. Everything else is unchanged.
const behindTls = process.env.LOADSTAR_BEHIND_TLS === "true";

/** Standard security headers. CSP allows Google Fonts for the bundled UI only. */
export const headers = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      // null removes Helmet's merged-in default; only set when TLS is real.
      ...(behindTls ? {} : { upgradeInsecureRequests: null }),
    },
  },
  hsts: behindTls,
});

/** Global limiter — tune per-route for production. */
export const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  // Test-only mock auth endpoints are a load-test target; don't rate-limit them.
  skip: (req) => req.path.startsWith("/api/mock/"),
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

/**
 * Minimal API-key auth. Set LOADSTAR_API_KEY in .env.
 * Swap for real user accounts + RBAC + SSO/SAML in the SaaS phase.
 */
/**
 * Brute-force guard on the API key. SEPARATE from the global limiter, which
 * is 120/min and counts every page load, poll and export — it cannot be
 * lowered without breaking the UI.
 *
 * This one counts ONLY 401s: 10 failed key attempts per hour, per IP.
 *   before: 120/min = 172,800 guesses/day
 *   after:   10/hr  =     240 guesses/day
 *
 * Why it matters: uploaded scripts are arbitrary code execution BY DESIGN
 * (see SECURITY.md). On a public host, a guessed key is RCE, not a data leak.
 *
 * A correct key RESETS the counter (see apiKeyAuth), so typos never build up
 * toward a lockout. An attacker never supplies a correct key, so that reset
 * can never help them.
 *
 * TRADE-OFF: 10 consecutive failures block that IP for the rest of the window,
 * INCLUDING the legitimate operator. Inherent — the block must precede the key
 * check or it is trivially bypassed. The store is in memory, so restarting the
 * api container clears it.
 */
export const authLimiter = rateLimit({
  windowMs: Number(process.env.AUTH_RATE_WINDOW_MS || 60 * 60 * 1000),
  limit: Number(process.env.AUTH_RATE_LIMIT || 10),
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  skip: () => !process.env.LOADSTAR_API_KEY, // open mode: no 401s are possible
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error:
      "Too many failed API-key attempts from this address. Wait for the window to expire, " +
      "or restart the api container to clear it.",
  },
});

/**
 * Minimal API-key auth. Set LOADSTAR_API_KEY in .env.
 * Swap for real user accounts + RBAC + SSO/SAML in the SaaS phase.
 */
export function apiKeyAuth(req, res, next) {
  const configured = process.env.LOADSTAR_API_KEY;
  if (!configured) return next(); // open mode for local development
  const provided = req.get("x-api-key");
  if (provided && provided === configured) {
    // Correct key: clear this IP's failure count so a run of typos never
    // accumulates into a lockout. Unreachable for an attacker by definition.
    try {
      authLimiter.resetKey(ipKeyGenerator(req.ip));
    } catch {
      /* never let a bookkeeping failure block a valid request */
    }
    return next();
  }
  return res.status(401).json({ error: "Missing or invalid X-API-Key header." });
}

/**
 * Shout about a weak key at boot. Does NOT refuse to start — that is the
 * operator's call. But it must not pass in silence: Loadstar currently accepts
 * LOADSTAR_API_KEY=abc, and on a public host that key is the only thing between
 * the internet and arbitrary code execution.
 */
export function warnOnWeakApiKey() {
  const k = process.env.LOADSTAR_API_KEY;
  if (!k) {
    console.warn(
      "[security] LOADSTAR_API_KEY is not set — the API is in OPEN MODE (no auth). " +
        "Fine on a private machine. NEVER expose this to the internet: uploaded scripts " +
        "execute arbitrary code by design."
    );
    return;
  }
  if (k.length < 24) {
    console.warn(
      "[security] LOADSTAR_API_KEY is only " + k.length + " characters. That is GUESSABLE. " +
        "Generate a real one:  openssl rand -hex 32  " +
        "A guessed key on a public host means remote code execution, not just data access."
    );
  }
}

/** Tiny validation helper: returns error string or null. */
export function validateTestInput(b) {
  if (!b || typeof b !== "object") return "Request body must be JSON.";
  if (!b.name || String(b.name).length > 120) return "name is required (max 120 chars).";
  let url;
  try {
    url = new URL(b.target_url);
  } catch {
    return "target_url must be a valid absolute URL.";
  }
  if (!["http:", "https:"].includes(url.protocol)) return "Only http/https targets are supported.";
  const allowPrivate = process.env.ALLOW_PRIVATE_TARGETS === "true";
  if (!allowPrivate && isPrivateAddress(url.hostname))
    return "Private/loopback targets are blocked. Set ALLOW_PRIVATE_TARGETS=true for local development.";

  if (b.notify_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.notify_email))
    return "notify_email must be a valid email address.";
  if (b.engine && !["jmeter", "k6", "playwright"].includes(b.engine))
    return "engine must be jmeter, k6, or playwright.";
  if (b.sla) {
    const allowed = ["max_p95_ms", "max_error_rate", "min_throughput_rps", "min_pass_rate", "max_avg_flow_ms"];
    for (const [k, v] of Object.entries(b.sla)) {
      if (!allowed.includes(k)) return `Unknown SLA key "${k}". Allowed: ${allowed.join(", ")}.`;
      if (typeof v !== "number" || v < 0 || v > 1e9) return `SLA "${k}" must be a non-negative number.`;
    }
  }

  if (b.test_type === "browser") return validateBrowserFields(b);
  return validateHttpFields(b);
}

const BROWSER_ACTIONS = ["goto", "click", "fill", "expect_text", "expect_no_text", "expect_visible", "expect_url", "wait_for", "pause"];

function validateBrowserFields(b) {
  const maxUsers = Number(process.env.MAX_BROWSER_USERS || 5);
  const users = Number(b.virtual_users ?? 1);
  if (!Number.isInteger(users) || users < 1 || users > maxUsers)
    return `Browser tests support 1 to ${maxUsers} parallel users (real browsers are heavy).`;
  const loops = Number(b.loops ?? 1);
  const maxLoops = Number(process.env.MAX_BROWSER_LOOPS || 10);
  if (!Number.isInteger(loops) || loops < 1 || loops > maxLoops) return `loops must be between 1 and ${maxLoops}.`;
  if (!Array.isArray(b.browser_steps) || b.browser_steps.length < 1 || b.browser_steps.length > 30)
    return "Browser tests need 1 to 30 steps.";
  for (const [i, s] of b.browser_steps.entries()) {
    const n = `Step ${i + 1}`;
    if (!s || !BROWSER_ACTIONS.includes(s.action))
      return `${n}: action must be one of ${BROWSER_ACTIONS.join(", ")}.`;
    if (["click", "fill", "wait_for", "expect_visible"].includes(s.action) && !s.selector)
      return `${n} (${s.action}): needs a selector, e.g. text=Sign in or #email.`;
    if (["fill", "expect_text", "expect_no_text", "expect_url", "goto", "pause"].includes(s.action) && !s.value)
      return `${n} (${s.action}): needs a value.`;
    if ((s.selector || "").length > 500 || (s.value || "").length > 2000)
      return `${n}: selector/value too long.`;
    if (s.action === "pause" && !(Number(s.value) >= 100 && Number(s.value) <= 30000))
      return `${n}: pause must be 100–30000 milliseconds.`;
    if (s.action === "goto") {
      try {
        const u = new URL(s.value);
        if (!["http:", "https:"].includes(u.protocol)) return `${n}: goto needs an http(s) URL.`;
      } catch { return `${n}: goto needs a full URL like https://…`; }
    }
  }
  return null;
}


const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
/** Validate a multi-request array. Returns error string or null. */
function validateRequestsArray(reqs) {
  if (!Array.isArray(reqs)) return "requests must be an array.";
  if (reqs.length < 1 || reqs.length > 20) return "A test needs 1 to 20 requests.";
  for (const [i, r] of reqs.entries()) {
    const n = "Request " + (i + 1);
    if (!r || typeof r !== "object") return n + ": must be an object.";
    if (!HTTP_METHODS.includes(r.method)) return n + ": method must be one of " + HTTP_METHODS.join(", ") + ".";
    if (!r.path || typeof r.path !== "string" || r.path.length > 2000) return n + ": needs a path (max 2000 chars).";
    if (r.headers && typeof r.headers !== "object") return n + ": headers must be a JSON object.";
    if (r.body && typeof r.body !== "string") return n + ": body must be a string.";
    if (r.name && String(r.name).length > 80) return n + ": name too long.";

    // --- assert ---
    // Values are embedded via JSON.stringify into the generated k6 script (so they
    // are data, not code — no injection) and esc()'d into JMeter XML. What is missing
    // is type/size checking: an object where a string belongs produces a check that
    // can never match, which LOOKS configured and silently never fires.
    if (r.assert != null) {
      if (typeof r.assert !== "object" || Array.isArray(r.assert)) return n + ": assert must be an object.";
      const a = r.assert;
      if (a.status != null) {
        if (!Number.isInteger(a.status) || a.status < 100 || a.status > 599)
          return n + ": assert.status must be an integer between 100 and 599.";
      }
      for (const k of ["body_contains", "body_excludes", "header_name", "header_contains"]) {
        if (a[k] == null) continue;
        if (typeof a[k] !== "string") return n + ": assert." + k + " must be a string.";
        if (a[k].length > 500) return n + ": assert." + k + " is too long (max 500 chars).";
      }
      if ((a.header_name == null) !== (a.header_contains == null))
        return n + ": a header assertion needs BOTH header_name and header_contains.";
    }

    // --- extract (response chaining) ---
    // extract.path is compiled with new RegExp() for regex sources, so an unbounded
    // pattern is a ReDoS vector INSIDE our own k6 process. Cap it.
    if (r.extract != null) {
      if (typeof r.extract !== "object" || Array.isArray(r.extract)) return n + ": extract must be an object.";
      const e = r.extract;
      if (!e.var || typeof e.var !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(e.var))
        return n + ": extract.var must be a variable name (letters, digits, underscore; max 41 chars).";
      if (!["json", "header", "regex"].includes(e.source)) return n + ": extract.source must be json, header, or regex.";
      if (e.path != null && (typeof e.path !== "string" || e.path.length > 300))
        return n + ": extract.path must be a string of at most 300 chars.";
    }

    // --- think time ---
    if (r.think_time_ms != null) {
      if (!Number.isFinite(Number(r.think_time_ms)) || Number(r.think_time_ms) < 0 || Number(r.think_time_ms) > 300000)
        return n + ": think_time_ms must be between 0 and 300000 (5 minutes).";
    }
    if (r.think_time_jitter_pct != null) {
      if (!Number.isFinite(Number(r.think_time_jitter_pct)) || Number(r.think_time_jitter_pct) < 0 || Number(r.think_time_jitter_pct) > 90)
        return n + ": think_time_jitter_pct must be between 0 and 90.";
    }
  }
  return null;
}

function validateHttpFields(b) {
  if (b.requests != null) { const e = validateRequestsArray(b.requests); if (e) return e; }
  const modes = ["load", "stress", "spike", "soak"];
  if (b.mode && !modes.includes(b.mode)) return `mode must be one of: ${modes.join(", ")}`;
  const vu = Number(b.virtual_users ?? 10);
  const maxVu = Number(process.env.MAX_VIRTUAL_USERS || 500);
  if (!Number.isInteger(vu) || vu < 1 || vu > maxVu)
    return `virtual_users must be an integer between 1 and ${maxVu}.`;
  const dur = Number(b.duration_secs ?? 120);
  // MAX_DURATION_SECS=0 means no ceiling — the user decides. A long soak occupies a
  // worker for its whole duration, so other tests queue behind it; that is a trade-off
  // for the operator to make, not a limit for us to impose.
  const maxDur = Number(process.env.MAX_DURATION_SECS || 3600);
  if (!Number.isInteger(dur) || dur < 10)
    return "duration_secs must be at least 10.";
  if (maxDur > 0 && dur > maxDur)
    return `duration_secs must be between 10 and ${maxDur} (raise MAX_DURATION_SECS, or set it to 0 for no limit).`;
  if (b.method && !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(b.method))
    return "Unsupported HTTP method.";
  if (b.csv_data) {
    if (typeof b.csv_data !== "string" || b.csv_data.length > 200_000)
      return "CSV data must be text under 200 KB.";
    const firstLine = b.csv_data.split("\n")[0]?.trim();
    if (!firstLine || !/^[\w][\w ,.-]*$/.test(firstLine))
      return "CSV must start with a header row of column names (letters, numbers, commas).";
  }
  return null;
}
