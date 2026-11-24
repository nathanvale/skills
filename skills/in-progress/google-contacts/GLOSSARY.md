# Google Contacts

Portable address book hygiene, evidence-backed enrichment, and safe mutation planning for Google Contacts. This glossary defines the canonical language for inspecting an address book, gathering corroborating evidence, and applying reviewed changes without silent data loss.

## Language

### Address book and identity

**Account**:
A single authenticated Google identity (and optional OAuth client name) whose address book and companion mail history are being inspected or curated.
_Avoid_: Profile, user, mailbox

**Contact**:
One human or organization item owned by an Account in Google Contacts, uniquely identified across edits and merges.
_Avoid_: Person, entry, card, vCard, record

**Contact snapshot**:
A point-in-time read-only capture of Contacts in an Account, taken before analysis so audits and proposals evaluate a stable baseline.
_Avoid_: Export, backup, dump, cache

**Contact revision**:
The version token of a Contact at the moment it was read, used to detect concurrent external edits before any mutation is applied.
_Avoid_: Version, timestamp, etag, hash

**Identity anchor**:
An independently verifiable identifier on a Contact, such as a normalized phone number, email address, or organization domain, used to match Contacts or evidence without relying on a display name alone.
_Avoid_: Key, match signal, lookup key

### Evidence and enrichment

**Audit finding**:
A classified hygiene defect or enrichment gap detected across one or more Contacts, such as a malformed phone number, duplicate pair, sparse Contact, or stale detail.
_Avoid_: Issue, warning, problem, recommendation

**Evidence item**:
A sourced factual excerpt gathered from private correspondence or public web pages that supports a proposed Contact update or merge.
_Avoid_: Proof, citation, snippet, clue

**Evidence lane**:
One distinct source channel for gathering Evidence items, specifically `gmail`, optional macOS `imsg`, or `web-queue`. The `web-queue` lane is off in v1.
_Avoid_: Provider, connector, scraper, integration

**Web eligibility**:
The qualification rule governing whether a Contact may be researched on the public web, requiring a non-ambiguous Identity anchor beyond a bare personal name and prohibiting private sensitive details in search queries.
_Avoid_: Searchable, lookup-ready, enrichable

**Web research queue**:
The redacted list of public-only query anchors that `evidence` emits for Web eligibility-approved Contacts. Web research is off in v1, so the list is always empty. Web research will return with a rebuilt guard.
_Avoid_: Search batch, scrape list, lookup queue

**Anchored name**:
The personal name of a Web eligibility-approved Contact, recorded in the Mutation plan's leak guard with that Contact's organization name and domain. Web research is off in v1, so no step reads the leak guard.
_Avoid_: Safe name, public name, allowed name

**Confidence tier**:
The classification of a proposed change (`high`, `medium`, or `low`) expressing the strength and corroboration of its supporting Evidence items.
_Avoid_: Score, certainty, trust level

### Changes, safety, and recovery

**Change lane**:
One disjoint review category of Contact mutation (`phone-normalize`, `metadata-enrich`, `note-append`, `duplicate-merge`, or `contact-delete`). Separate Field-mask sub-batches prevent Google People API union-mask erasure across sibling Contacts, while `duplicate-merge` transfers multiple allowlisted field families onto one Survivor contact.
_Avoid_: Patch type, operation mode, update group

**Field-mask sub-batch**:
A subset of updates inside one Mutation plan sharing an identical sorted top-level field-mask signature so Google's union field mask cannot touch omitted fields on sibling Contacts.
_Avoid_: Update chunk, API batch, slice

**Proposal**:
A structured caller-supplied candidate edit, merge, or deletion conforming to `contacts-proposals/1` and passed to `plan` through `--proposals`.
_Avoid_: Draft patch, suggestion, raw input

**Human confirmation marker**:
An explicit structured flag and rationale attached to a Proposal recording that a person approved a deletion or low-anchor duplicate merge during review.
_Avoid_: Bypass flag, force flag, override token

**Survivor contact**:
The Contact retained during a duplicate merge, receiving allowlisted merged fields and a provenance note before any Duplicate contact is deleted.
_Avoid_: Primary, master, target, winner

**Duplicate contact**:
A redundant Contact corroborated by two or more independent Identity anchors or a Human confirmation marker as the same human or organization as a Survivor contact, eligible for deletion only after read-back confirms all merged values landed on the Survivor contact.
_Avoid_: Secondary, loser, source, redundant item

**Merge cluster**:
One Survivor contact together with all Duplicate contacts being merged into it, kept atomic inside a single Mutation plan and never split across plans.
_Avoid_: Merge group, dedupe set, pair

**Mutation plan**:
An immutable, reviewable set of changes naming one Account, target Contacts, expected Contact revisions, one Change lane, exact Field-mask sub-batches, and supporting Evidence items.
_Avoid_: Diff, batch, job, changeset, preview

**Plan seal**:
The unkeyed SHA-256 fingerprint verifying that the Mutation plan passed to `apply` matches the exact plan compiled at `plan` time. Human authorization rests on the approval gate in `SKILL.md` rather than the seal itself.
_Avoid_: Token, approval grant, signature, checksum

**Contact ledger**:
The local durable store (`GOOGLE_CONTACTS_LEDGER_DIR`, `$NATHANVALE_SKILLS_DATA_HOME/google-contacts/ledger`, `$XDG_DATA_HOME/nathanvale-skills/google-contacts/ledger`, or `$HOME/.local/share/nathanvale-skills/google-contacts/ledger`) tracking in-flight and unfinished Google Contacts mutations so an interrupted change blocks only the affected Contacts until a qualified close exists.
_Avoid_: State folder, state dir, journal dir, database

**Suite root**:
The absolute folder that a suite's components live under. For data, `$NATHANVALE_SKILLS_DATA_HOME` sets it when absolute, else it is `$XDG_DATA_HOME/nathanvale-skills`, else `$HOME/.local/share/nathanvale-skills`. The Contact ledger lives at `google-contacts/ledger` inside it.
_Avoid_: Suite data home, State home, coordination folder

**Unfinished mutation**:
A recorded Contact change that started without confirmed completion, blocking subsequent mutations to the affected Contacts until a qualified close exists.
_Avoid_: Pending job, failed batch, stuck lock, orphan
