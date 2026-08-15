# Contributing

**Loadstar is not accepting external contributions.**

Issues and pull requests are disabled on this repository. Please don't spend time
preparing a patch — it won't be reviewed or merged, and that would waste your effort
rather than reflect on your work.

## Why

Loadstar is developed by a single maintainer and the architecture is still moving
quickly — the test format, the report schema, and the engine interface are all
expected to change. Accepting outside code against foundations that are being rebuilt
creates work for contributors that gets thrown away, and review overhead that slows
the rebuild.

This repository is published so the tool can be **read, run, forked, and used**, not
as an invitation to co-develop it. That may change once the architecture settles. If
it does, this file will say so.

An earlier version of this file invited contributions and the repository carried
`good first issue` labels. That was a mistake and has been corrected — apologies to
anyone who acted on it.

## What you can do instead

- **Use it.** Apache-2.0. Run it, self-host it, put it in your CI.
- **Fork it.** The license permits it explicitly. If you want Loadstar to work
  differently, a fork is the supported path and needs nobody's permission.
- **Report a security issue.** Vulnerabilities are the one thing worth telling the
  maintainer about — open a private security advisory on this repository. See
  `SECURITY.md`.

## Licensing

Loadstar's own code is Apache-2.0 (see `LICENSE`). The engines it invokes carry their
own licenses — notably k6, which is AGPL-3.0. See `THIRD_PARTY.md` before
redistributing or offering Loadstar as a hosted service.
