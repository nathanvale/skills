---
status: accepted
---

# Keep live public web search outside the portable CLI behind a deterministic Web eligibility firewall

Public web enrichment is valuable for sparse Contacts, but baking HTTP clients, third-party API keys, or private connector wrappers into the portable zero-`node_modules` skill bundle breaks portability across agent harnesses and leaks credentials or private contact data. We keep live web execution strictly outside the CLI. First `evidence` evaluates `Web eligibility` deterministically and strips private phone numbers, personal emails, free-mail domains, and residential addresses before emitting a redacted `Web research queue`. Next the host agent executes queries through native harness web search (or opportunistic Firecrawl). Finally `plan` and `apply` run post-query leak detection on recorded web query strings so leaked findings cannot enter a `Mutation plan`.

## Considered Options

- **Calling Firecrawl or a web-search CLI directly inside the CLI through `programsAddon`**: Rejected because it introduces a third external binary seam, couples a public skill to optional third-party credentials and billing, and breaks environments where only the host harness's built-in web search is available.
- **Trusting `SKILL.md` prose alone with no CLI input check**: Rejected because prose instructions cannot reject malformed or leaky recorded `Evidence item`s before they enter a compiled `Mutation plan`.

## Consequences

- The portable CLI maintains only two external binary seams (`gog` and optional macOS `imsg`), with zero runtime network code or API key custody inside `dist/cli.mjs`.
- Outbound stripping before `webResearchQueue` prevents CLI-generated queries from leaking private fields, while inbound detection on `plan` and `apply` catches post-query leaks on agent-recorded query strings (detecting leaked queries after search rather than intercepting host-harness HTTP calls at query time).
