# Loadstar

[![CI](https://github.com/kalkiyama/loadstar/actions/workflows/ci.yml/badge.svg)](https://github.com/kalkiyama/loadstar/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/kalkiyama/loadstar)](https://github.com/kalkiyama/loadstar/releases)

**JMeter power without JMeter's pain — self-hosted and free.**

> Source-available under Apache-2.0: read it, run it, fork it. Loadstar is developed
> by a single maintainer and is **not accepting external contributions** — issues and
> pull requests are disabled. Security vulnerabilities are the exception: please open a
> private advisory (see `SECURITY.md`).

Describe the test you want — load, stress, spike, soak, or a click-through browser flow —
and Loadstar generates and runs it (JMeter, k6, or Playwright), streams the results into
an instrument-grade report, and has Claude tell you what the numbers mean.

![Loadstar in 90 seconds: describe a test, watch live metrics, read the AI verdict](docs/demo.gif)

**Why it exists:** the load-testing world is bimodal — powerful-but-painful open source,
and pleasant-but-expensive SaaS. Loadstar is the empty seat between them: a pleasant,
self-hostable, open-source control plane.

**Why it's different:** Loadstar tells you when its own numbers are lies. Generator
saturated? The report says your throughput number is a floor, not a ceiling. Streaming
endpoint? It flags that "latency" hides time-to-first-token. Distributed run? Percentiles
are merged exactly from raw histograms — never averaged. Honest numbers first; the AI
verdict is built on top of them, not instead of them.

```bash
git clone https://github.com/kalkiyama/loadstar.git && cd loadstar
cp .env.example .env          # add ANTHROPIC_API_KEY for AI analysis (optional)
docker compose up --build
open http://localhost:8080    # test something you own in the next 5 minutes
```

**New here?** The **[Usage Guide](USAGE.md)** walks every feature with screenshots ·
**[GETTING_STARTED.md](GETTING_STARTED.md)** assumes zero terminal experience ·
**[BROWSER_TESTING.md](BROWSER_TESTING.md)** covers no-code browser tests.

## Screenshots

### Configure a test
Choose your test type — load/stress (JMeter or k6), functional browser tests (Playwright), or bring your own script. Every run is analyzed by Claude.

![New test](docs/screenshots/new-test.png)

### AI-powered analysis
Each run gets a Claude-generated verdict, findings, pros/cons, and recommendations — with trend comparison against past runs.

![AI report](docs/screenshots/ai-report.png)

### Live metrics
Throughput, latency percentiles, and error rate over the life of the run.

![Metrics chart](docs/screenshots/metrics-chart.png)

### Cross-browser testing
Run functional tests on Chromium, Firefox, or WebKit — the report shows which engine ran.

![Cross-browser](docs/screenshots/cross-browser.png)

### Run history & trends
Track every run and compare against previous results.

![Runs history](docs/screenshots/runs-history.png)

### Tests library
Save, re-run, download, or delete your tests. Filter by functional and non-functional.

![Tests library](docs/screenshots/tests-library.png)

### Scheduling & alerts
Run tests on a schedule (every 15 min to weekly) and get webhook alerts (Slack, Discord, Teams) when something breaks.

![Schedules](docs/screenshots/schedules.png)


## What works today (MVP)

- **API & web performance tests** against any HTTP/HTTPS endpoint (method, headers, body)
- **Browser (functional/UI) tests** — a no-code step builder (click, type, expect text…) executed by Playwright with 1–5 parallel real-browser users, per-step timings, and automatic failure screenshots
- **Four test modes**: load (ramp & hold), stress (continuous ramp to find the ceiling), spike (baseline + sudden burst), soak (long endurance)
- **Two load engines** — battle-tested JMeter or modern, lightweight k6, chosen per test; same UI and reports either way
- **Multi-request API sequences** — chain GET/POST/PUT/DELETE calls in one test (login → fetch → update → delete); works on both engines
- **Cross-browser testing** — run functional tests on Chromium, Firefox, or WebKit (Safari's engine); the report shows which engine ran
- **Response chaining** — capture a token or session cookie from one response (JSON path, response header, or regex) and reuse it in later requests; automatic session-cookie handling for authenticated load tests
- **Bring your own script** — upload an existing JMeter (.jmx) or k6 (.js) script and run it as-is against the installed engine, with best-effort version-compatibility warnings
- **CI/CD gate** — set pass/fail thresholds (max p95, max error rate, min pass rate) and use `ci/run-test.sh` in GitHub Actions to automatically fail builds on performance regressions (see `ci/github-actions-example.yml`)
- **Generated JMeter plans** — users never touch JMX; download it anytime via `GET /api/tests/:id/jmx`
- **CSV parameterization** — upload a data file, use `${column}` placeholders in URL/headers/body; each virtual user reads the next row
- **Full metrics report**: throughput, error rate, avg/min/max, p50/p90/p95/p99, per-second time series chart
- **AI analysis by Claude** (built in): every run gets a verdict, plain-English headline, findings, suspected causes, and recommendations — with **trend vs past runs** (improving/regressing/stable), pros, and cons. Powered by Claude via the Anthropic API; add your key to `.env` to enable.
- **Email reports** — after every run, an HTML email with the metrics, Claude's verdict, and a comparison against the last 5 runs (what improved, what got worse); works with any SMTP account
- **Report exports** — from any finished report: standalone HTML, print-quality PDF (rendered by the Playwright worker), a PowerPoint deck with native charts, or email all three as attachments
- **Selenium .side import** — convert Selenium IDE recordings into Loadstar steps in one click
- **Scheduled regression runs** — run any test every 15 min/hour/6 h/day, with Slack/Discord/Teams webhook alerts when a run goes unhealthy
- **Browser under load** — measure a real user's browser flow while a background load test hammers the same target
- **Anti-abuse target verification**: public domains must prove ownership before receiving load
- **Audit log, API-key auth, rate limiting, SSRF guards** built in from day one

## Quickstart

```bash
cp .env.example .env          # add ANTHROPIC_API_KEY for AI analysis (optional)
docker compose up --build     # db + api + worker
open http://localhost:8080
```

**Email reports:** fill the SMTP block in `.env` (for Gmail: host `smtp.gmail.com`, port 587,
your address, and an App Password from myaccount.google.com/apppasswords — not your normal
password), set `REPORT_EMAIL_TO`, restart. Each test can also set its own recipient in the UI.

Scale load generators locally:

```bash
docker compose up --scale worker=3
```

Run against your own local service? Keep `ALLOW_PRIVATE_TARGETS=true` (the default in `.env.example`).
Deploying anywhere shared? Set `LOADSTAR_API_KEY`, set `ALLOW_PRIVATE_TARGETS=false`, and never enable `SKIP_TARGET_VERIFICATION`.

## Do I need an API key?

**Running Loadstar on your own machine? No.**

Leave `LOADSTAR_API_KEY` empty in `.env`. Everything works — no key, no login,
no prompts. This is the default, and it is the right setting for local use.

**Hosting Loadstar somewhere other people can reach it? Yes — and generate a real key:**

```bash
openssl rand -hex 32
```

Put the result in `.env` as `LOADSTAR_API_KEY`. Do not invent one by hand: a short
or guessable key is worse than useless, because it looks like protection.

### Why this matters more here than for most tools

Loadstar runs the scripts you give it. That is the point — bring your own `.jmx`
or `.js` and Loadstar executes it. Which means:

> **Anyone who can reach your Loadstar can run code on the machine hosting it.**

On your laptop, that person is you. Fine.

On a public server with no key, that person is *anyone on the internet*. An open
Loadstar on a public address is not a data-leak risk — it is remote code execution.

So the rule is simple:

| Where Loadstar runs | Key needed? |
| --- | --- |
| Your own machine / a private network | No — leave it empty |
| A shared or public server | **Yes — `openssl rand -hex 32`** |

### The other guard: you must prove you own the target

Loadstar will not fire load at a domain you have not verified. You prove control by
serving a token at `https://your-domain/.well-known/loadstar-verify.txt`. Private and
cloud-metadata addresses are blocked outright (`ALLOW_PRIVATE_TARGETS` is `false` by
default — only turn it on for local practice targets like the bundled `demo`).

That guard is what stops Loadstar being aimed at somebody else's website. Leave it on.

### What this is not

One shared key, and everyone holding it is a full admin. There are no user accounts,
no roles, and no way to revoke access for one person — you rotate the key and everyone
re-enters it. Multi-user access control is on the roadmap; it does not exist yet. Plan
accordingly before putting Loadstar in front of a team.

See `SECURITY.md` for the full threat model.

## Distributed load generation

For load beyond what one machine can generate, Loadstar splits a test across
multiple worker containers ("generators") and merges their results into one
report.

**Triggering.** Any load test above the threshold (default 100 VUs)
automatically fans out into shards — one per generator. Below the threshold, a
single worker runs the test normally.

**Requires multiple workers.** Run `docker compose up --scale worker=3`.
Distribution needs at least two workers (one coordinates while the others
generate). On a single worker, a large test's shards have nothing to claim
them — so scale up before running a distributed test.

**Results are exact, not approximate.** Latency percentiles (p50–p99) are
computed by merging the generators' raw histograms, not by averaging — so a
distributed run's numbers are as accurate as a single-machine run's. Requests,
errors, and throughput are summed across generators. A distributed run's report
shows ` · N generators` in its header.

**Performance needs real hardware.** Distribution's *correctness* is independent
of where generators run, but the *speedup* is not: multiple generators on one
physical machine simply contend for the same CPU. The throughput benefit is
real only when generators run on separate machines. (Managed multi-machine
deployment is roadmapped as D2/D3.)

## API sketch

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/tests` | Create a test definition |
| GET | `/api/tests/:id/jmx` | Download the generated JMeter plan |
| POST | `/api/tests/:id/runs` | Queue a run (target must be verified) |
| GET | `/api/runs/:id` | Run status, metrics, time series, AI analysis |
| POST | `/api/runs/:id/analyze` | (Re-)run Claude analysis on a finished run |
| POST | `/api/targets/verify` | Get/check a domain verification token |

Auth: send `X-API-Key` when `LOADSTAR_API_KEY` is set.

## Roadmap (open-core)

**Recently shipped:** self-hosted distributed load generation (multi-worker,
exact histogram-merge — see above), per-request think time, AI run analysis
with load-profile awareness.

**Open source core**
- Distributed uploaded scripts: run a bring-your-own k6/JMeter script on N generators (Nx load, merged) — distinct from VU-splitting because Loadstar runs scripts verbatim and cannot rewrite the VU count inside them; must be labeled as a load *multiplier*
1. Git-backed test script versioning
2. WebSocket / gRPC / GraphQL protocol support
3. GitLab CI and Jenkins gate scripts (GitHub Actions is built in)
4. Monitoring correlation (Prometheus/node-exporter ingestion alongside load metrics)
5. Browser-extension recorder

**Commercial cloud (funds the project)**
1. Multi-tenant SaaS, teams, RBAC
2. Geo-distributed load generators with dedicated IPs (managed, multi-machine — extends the self-hosted distributed core)
3. On-prem/private load generator agents (test internal apps from the cloud console)
   - generator saturation detection (warn when a generator CPU/mem is the bottleneck, not the target) — meaningful once generators run on separate machines
4. SSO/SAML, advanced audit retention, SOC 2
5. Real-time collaboration & comments on reports; email alerting (webhooks are built in)
6. AI test generation from natural language and OpenAPI specs

## License

Loadstar's own code in this repository is licensed under **Apache-2.0** (see `LICENSE`).

Loadstar downloads and runs third-party engines that are **not** included here and
carry their own licenses — most importantly **k6, which is AGPL-3.0**. k6 is
downloaded at build time as an unmodified official release binary and invoked as a
separate subprocess; Loadstar does not modify or link against it. Apache JMeter and
Playwright are Apache-2.0. See [`THIRD_PARTY.md`](THIRD_PARTY.md) for the full list
and details.

If you plan to offer Loadstar as a hosted/network service, review k6's AGPL-3.0
terms (and `THIRD_PARTY.md`) with qualified counsel first.
