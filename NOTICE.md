# Third-party notices

## career-ops (vendored)

`vendor/career-ops/` contains files copied from **career-ops v1.30.0**
(<https://github.com/santifer/career-ops>), used here as the full-sweep engine that walks
public ATS board directories.

Copyright (c) 2026 Santiago Fernández de Valderrama. Licensed under the MIT License; the
full text ships at `vendor/career-ops/LICENSE`.

**What is vendored:** only the modules the sweep entry point imports — the ATS providers
(Greenhouse, Lever, Ashby, Workday, iCIMS), the shared HTTP/DNS layer, the filter builders
and the board-directory seeds. The rest of career-ops (tracker workflow, CV/PDF generation,
evaluation modes) is not included.

**Modifications:** any change made to vendored files is recorded in
`vendor/career-ops/MODIFICATIONS.md`. Upstream files are otherwise copied verbatim so they
can be diffed against a newer release.

## Everything else

All other code in this repository is original work under the MIT License; see `LICENSE`.
