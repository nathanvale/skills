---
status: accepted
---

# Plan-as-data pipeline with one changing command and domain Plan seal

Google Contacts mutations are irreversible (deletions) or hard to untangle (partial merges), so callers must inspect exact diffs before any write touches an Account. We chose a 7-command Plan-as-Data pipeline (6 read-only `inspect` commands `doctor`, `snapshot`, `audit`, `evidence`, `plan`, `pending`, with `plan` completely pure and zero subprocesses, plus 1 `changing` command `apply`) protected by an integrity `Plan seal` rather than per-lane mutating commands or `agent-cli-kernel`'s `approval` add-on. Funneling all writes through one `changing` command keeps preview compilation 100% pure on disk and network, shrinks the required declared station surface from 79 to 27 (including `DOMAIN_CONTACTS_PLAN_INVALID` re-validation on `apply`), and relies on `SKILL.md` for human authorization while `Plan seal` guarantees review-to-apply integrity.

## Considered Options

- **Per-lane mutating commands (`normalize-phones`, `enrich-metadata`, `append-notes`, `merge-duplicates`, `delete-contacts`)**: Rejected because every `changing` command in `agent-cli-kernel` repeats the full coordination and failure station matrix (79 required stations and 5x `verify-cli` changing-command suites), and `applyChangingState()` requires a `state.transaction()` proof even for `SUCCESS_UNCHANGED`, making `--dry-run` mutate the `Contact ledger` on disk.
- **Keep `plan --dry-run` inside `plan` (`programs` capability)**: Rejected because `gog --dry-run` only prints intended actions locally without catching server validation errors, while coupling a pure offline compiler to an external mutating subcommand surface.
- **Ultra-minimal 4-command CLI folding read commands into `inspect <mode>`**: Rejected because `agent-cli-kernel`'s `InputSchema` supports presence-based `requires` and `exclusive` constraints rather than value-conditional constraints; folding 4 read verbs increased stations while demoting invalid flag combinations from kernel exit-2 usage refusals to runtime domain refusals.
- **Enabling `agent-cli-kernel`'s `approval` add-on (`installedAddons: ["state", "programs", "approval"]`)**: Rejected because `approval()` requires an independent grant writer and foreign-UID `fileSeparation` down from `/` (impossible under `$HOME` on a single-user laptop), runs synchronous argv preflight before `--plan` is parsed, and binds one `ResourceId` and one revision rather than *N* Contacts with *N* `Contact revision`s.

## Consequences

- Every write flows through `snapshot`, `plan`, and `apply`. Each read command accepts either raw schema documents or unedited `--json` CLI envelopes (`result.data`) so callers need no `jq` glue.
- `Plan seal` is an unkeyed SHA-256 fingerprint proving plan integrity between `plan` and `apply`, not an unforgeable cryptographic authorization barrier against an arbitrary local caller. Human authorization lives in the `SKILL.md` confirmation gate, and `apply` independently re-validates all domain invariants (`DOMAIN_CONTACTS_PLAN_INVALID`).
- Replay protection relies on Google's advancing `Contact revision` (`etag`) verified live before transaction entry and carried on the wire rather than consumed-grant files on disk.
