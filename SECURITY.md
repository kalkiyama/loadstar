# Security posture

Loadstar is security-relevant in two directions: it must be a hard target
itself, and it must not become a weapon. Both are treated as product
requirements, not afterthoughts.

## Implemented in this MVP

**Abuse prevention (a load platform is a DDoS cannon if unguarded)**
- Domain ownership verification before any public target can receive load
  (`/.well-known/loadstar-verify.txt` token check)
- Private/loopback address ranges blocked by default (SSRF + internal-scan guard);
  opt-in via `ALLOW_PRIVATE_TARGETS` for self-hosted internal testing
- Hard caps on virtual users and duration (`MAX_VIRTUAL_USERS`, `MAX_DURATION_SECS`)

**Platform hardening**
- API-key authentication (`X-API-Key`), designed to be replaced by full
  user accounts + RBAC + SSO/SAML in the SaaS phase
- Rate limiting on all routes; JSON body size capped at 256 KB
- Security headers via helmet, including a restrictive CSP. HSTS and
  `upgrade-insecure-requests` are **off by default** — Loadstar serves plain HTTP,
  and both break the UI (and, in HSTS's case, poison the browser's view of
  `localhost` for a year). Set `LOADSTAR_BEHIND_TLS=true` when a reverse proxy
  terminates TLS in front of Loadstar; both headers are then emitted.
- Parameterized SQL everywhere — no string-built queries
- Input validation on every write endpoint; HTML escaping in the UI
- Central error handler: stack traces never reach clients
- Audit log table recording test creation, run lifecycle, and verifications

**Data boundaries**
- Claude receives aggregated metrics only — never response bodies, request
  headers, or credentials
- Worker temp directories (JMX/JTL) deleted after every run
- Secrets come exclusively from environment variables; `.env` is gitignored

## Operational cautions — read these

### Debug traces contain real secrets

Running a test with `debug: true` captures the **full request and response headers of
every request** — including `Authorization` headers carrying real tokens extracted from
a login step. That is the entire point: it is how you see whether response chaining
actually worked.

The consequence is that **those tokens are stored in plaintext** in the `runs.debug_trace`
column, are visible to anyone with API access, appear in database backups, and are
rendered in the UI.

- Run debug traces against **non-production credentials** only.
- Delete debug runs once you have what you need.
- **Treat a Loadstar database as containing secrets**, and back it up accordingly.

This is a deliberate trade-off, not an oversight — a debug trace that redacted the token
would not tell you whether the token was correct. But it should be a choice you make
knowingly.

### Never enable mock auth in production

`ENABLE_MOCK_AUTH=true` exposes `/api/mock/login`, which **issues a valid bearer token to
anyone who asks**, and `/api/mock/protected`, which accepts it. These exist only to prove
response chaining works against a known-good endpoint.

The default is `false`. Never enable it on a shared or internet-facing instance.

## Required before public SaaS launch

1. Real identity: user accounts, org tenancy, RBAC, then SSO/SAML (enterprise)
2. Secrets vault for stored test credentials (e.g., encrypted with KMS,
   never returned by the API after write)
3. Per-tenant isolation review: queries scoped by org id, tested with
   automated cross-tenant probes
4. TLS termination + HSTS at the edge; Postgres TLS in transit
5. Dependency and container scanning in CI (npm audit, Trivy) + Dependabot
6. Abuse monitoring: per-account load quotas, anomaly alerts, kill switch
7. Pen test before charging money; SOC 2 Type II on the enterprise path
8. Responsible disclosure policy (SECURITY.md contact + 90-day window)

## Reporting a vulnerability

Open a private security advisory on the repository, or email the
maintainers. Please do not open public issues for security reports.

## SSRF: resolve-time check, with a documented residual window

Before sending load at a verified domain, Loadstar resolves it and refuses if any
resolved address is private, loopback, link-local, or cloud-metadata
(169.254.169.254). Owning a domain is not sufficient — a verified domain that
resolves to an internal IP would otherwise turn the load generator into an SSRF
weapon against your own network or cloud metadata endpoint.

**Residual (known, tracked):** a TOCTOU window of a few seconds exists between this
check and the load engine's own DNS lookup. Fully closing it requires pinning the
resolved IP through both k6 and JMeter while preserving the Host header. Exploiting
the window requires an attacker who already controls the target's DNS and has passed
domain verification.

## Dependency advisories: what is flagged, and why it is not reachable

GitHub currently reports 12 Dependabot alerts on this repository, 5 of them High. All 12
have been reviewed. **None is reachable in Loadstar as shipped.** Rather than silence the
alerts, the reasoning is published here — a suppressed advisory tells you nothing about
whether it mattered.

**Ten of the twelve are in `mcp-server/`.** That package declares exactly two
dependencies: `@modelcontextprotocol/sdk` and `zod`. Everything flagged arrives beneath
the SDK.

- **`hono` and `@hono/node-server` — 5 alerts.** CORS ReDoS, language-middleware
  algorithmic DoS, `memo()` retaining SSR output across requests, proxy helper header
  handling, and a Windows-only `serve-static` path traversal. The MCP server uses
  `StdioServerTransport`: it communicates over stdin/stdout and **never opens a socket**.
  The SDK's HTTP transport — the only thing that would load `hono` — is never imported.
  These are unreachable by construction, not merely unused.
- **`ip-address` — 3 alerts.** SSRF and trust-boundary bypasses: leading-zero octets
  parsed as decimal where resolvers read octal, IPv4-mapped/NAT64 misclassification, and
  a CIDR suffix suppressing special-use classification.
- **`fast-uri` — 2 alerts.** Host confusion via a backslash authority delimiter.

**On the `ip-address` and `fast-uri` alerts specifically.** Five advisories about SSRF and
URL-parsing confusion, in a tool whose safety model is a target allow-list, deserves a
direct answer rather than a reassurance. It is this: `api/src/lib/ssrfGuard.js` — the
single implementation of "is this address internal", used by the running app and asserted
directly by `verify_ssrf.mjs` — **imports `node:net` and nothing else.** That was decided
long before these CVEs, after an inlined copy of the same logic drifted and stopped
proving anything. Loadstar's address classification has no third-party parser to be
confused. The flagged packages sit under an HTTP transport that is never loaded and play
no part in deciding whether a target may be tested.

**The remaining two are `image-size` in `api/`** — infinite loops in the ICNS, JXL and
HEIF parsers. Loadstar never invokes those parsers; the dependency arrives via PowerPoint
export. Accepted rather than fixed, because the available fix breaks PPTX generation.
Documented here rather than dismissed.

**This assessment is a snapshot.** It was made on 18 August 2026 against the alerts open
that day. New advisories are not covered by it, and the reasoning above is only valid
while `mcp-server` remains stdio-only and `ssrfGuard.js` remains dependency-free. Both are
load-bearing; changing either invalidates this section.
