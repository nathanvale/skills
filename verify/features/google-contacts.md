# Google Contacts portable CLI verification

The compiled zero-`node_modules` bundle at `skills/in-progress/google-contacts/dist/cli.mjs` exposes seven commands (`doctor`, `snapshot`, `audit`, `evidence`, `plan`, `apply`, `pending`) and 27 declared required host stations. The scenarios in `verify/scenarios/google-contacts-*.json` drive all 25 non-swept stations and the full `changing-command` lifecycle against deterministic synthetic `gog` and `imsg` stubs inside a run folder created by `verify.ts launch`.

## Sub-features

- `google-contacts-read-pipeline`: `snapshot`, `audit`, `evidence`, `plan`, and offline `apply` validation (`SUCCESS_UNCHANGED`, `SCHEMA_INVALID_INPUT`, `DOMAIN_CONTACTS_LANE_UNAVAILABLE`, `DOMAIN_CONTACTS_PLAN_INVALID`, `DOMAIN_CONTACTS_SEAL_MISMATCH`).
- `google-contacts-changing-command`: `first-run` (`SUCCESS_COMPLETED`), `second-run-drift` (`DOMAIN_CONTACTS_REVISION_DRIFT`), `nothing-pending`, `interrupted-run` (`SIGTERM` exit `143`), `interruption-blocks` (`DOMAIN_CONTACTS_APPLY_UNRESOLVED`), `interruption-is-listed` (`pending`), and `interruption-is-narrow` (sibling Contact succeeds).
- `google-contacts-gog-unavailable`: unauthenticated or read-only `gog` refusal (`DOMAIN_CONTACTS_GOG_UNAVAILABLE`).
- `google-contacts-transient`: retryable pre-transaction exit `7` (`TRANSIENT_NOT_STARTED`).
- `google-contacts-ledger-errors`: relative `GOOGLE_CONTACTS_LEDGER_DIR` refusal (`DOMAIN_CONTACTS_LEDGER_UNREADABLE`, `DOMAIN_CONTACTS_APPLY_UNAVAILABLE`).
- `google-contacts-apply-rejected`: clean non-zero rejection settled via live read-back (`DOMAIN_CONTACTS_APPLY_REJECTED`).
- `google-contacts-apply-unconfirmed`: failed post-mutation read-back leaving a narrow unfinished case (`DOMAIN_CONTACTS_APPLY_UNCONFIRMED`).
- `google-contacts-apply-held`: overlapping concurrent `apply` lock refusal (`DOMAIN_CONTACTS_APPLY_HELD`).

## How to get to it (user POV)

- Run `bun skills/in-progress/google-contacts/dist/cli.mjs --help` for the seven-command surface.
- Run `bun skills/in-progress/google-contacts/dist/cli.mjs --discover-command google-contacts.apply --json` to inspect `ifNoResult` (`google-contacts.pending`), `heldLockCause`, and `unresolvedCaseCause`.

## Driving it with verify-cli

Preconditions: `bun run build:skills` has produced an up-to-date `skills/in-progress/google-contacts/dist/cli.mjs`, `verify.ts ready` exits `0`, and `verify.ts launch <run-folder> skills/in-progress/google-contacts/dist/cli.mjs` has created `<run-folder>/scratch/`.

```text
bun node_modules/agent-cli-kernel/skills/verify-cli/verify.ts ready skills/in-progress/google-contacts/dist/cli.mjs
The target is ready: 8 readiness checks passed.

bun node_modules/agent-cli-kernel/skills/verify-cli/verify.ts sweep skills/in-progress/google-contacts/dist/cli.mjs
95 checks passed. Stations owed: 25.

bun node_modules/agent-cli-kernel/skills/verify-cli/verify.ts report <run-folder>
Stations: 1 swept, 26 driven, 0 owed. Steps: 29 met, 0 unmet.
```

## Gotchas

- Always point `GOOGLE_CONTACTS_LEDGER_DIR` inside `<run-folder>/scratch/` (except for `google-contacts-ledger-errors.json`, which passes a relative path to verify refusal without touching disk) so `verify.ts cleanup` removes all temporary ledger files cleanly.
- `google-contacts-changing-command.json` intentionally leaves `owner@example.com:people/c-hang` unresolved inside its ledger directory, so each subsequent `apply` fault scenario (`rejected`, `unconfirmed`, `held`) uses its own subdirectory under `{scratch}`.
