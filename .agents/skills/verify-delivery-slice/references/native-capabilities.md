# Capture native capability proof

Use this with Doctor and the selected journey's evidence checks. Keep evidence
scoped to the Harness and session that received the tools. Candidate root is
this repository (`$candidate_root`), candidate plugin is `nathanvale-skills`,
and candidate invocation is `nathanvale-skills:delivery-slice`. Capability
discovery and trace inspection require no setup, sign-in, permission change or
new client.

## Selection and capability-present behavior

### Implicit selection

Test implicit selection in fresh native sessions with ordinary user requests,
without naming `delivery-slice`, `nathanvale-skills:delivery-slice`, or
supplying its source path. Supply only the bounded input records under
`$candidate_root/.agents/skills/verify-delivery-slice/fixtures/`. Load the
candidate plugin `nathanvale-skills` from this repository root
(`$candidate_root`) using the Harness's native candidate route. Require an
actual load of `nathanvale-skills:delivery-slice` from the candidate, actual
reads of the installed `to-spec` and `to-tickets` owners, and a complete
result.

Use a separate nearby one-sentence rewrite (for example, tightening a single
draft ticket title or note with no Wayfinder outcome or slicing request) as a
negative control; `nathanvale-skills:delivery-slice` should not load. One
positive and one negative qualify those cases, not general selection rates.

### Capability-present and source-loading boundaries

An explicit-source desktop run can prove source behavior and live reads when
the native catalogue lacks the `nathanvale-skills` candidate. Record that
absence and the loaded source hash. It cannot pass installed-catalogue
discovery or fresh-CLI access. A foreground writer applying candidate
instructions qualifies that user path only, not autonomous native-catalogue
publication.

For a separate no-write journey with native mutation-capable controls available
(F5.4), retain actual tool discovery and runtime-returned API documentation,
plus all observed tool calls and their matched results. Authorize only reads or
conversation drafts. Require no mutation, publication, readiness or dispatch
attempt. This proves observed behavior with those controls present, not
successful publication or a complete remote audit. Keep this check distinct
from F5.3's bounded absent-tools journey.

A model-written tool list does not establish absent or offered tools. Without
independently recorded discovery or offered definitions, mark that inventory
unknown. Distinguish observed transport failure from authentication failure and
from tool absence.
