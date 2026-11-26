# Spec: cv-tailor, a public productivity skill on the CLI kernel

Written against rulebook v49. Owning repository: `nathanvale/skills`. Destination: `docs/specs/cv-tailor.md`. Status: draft for two blind reviews.

## Problem

A job seeker sends one generic CV to every role. Parsers misread it (a styled title can read as one word), recruiter Boolean searches miss terms the candidate can prove, and nobody tests the CV against a reader before it goes out. A prototype of this workflow exists as Python and shell scripts in a private, unpushed branch. It works, but it sits outside any kernel CLI, needs `uv` and `python-docx` at run time, and carries one user's folder layout.

## Solution

A new public skill, `skills/productivity/cv-tailor/`, with one portable kernel CLI named `cv-tailor`. The skill tailors a CV to one job ad from confirmed evidence, then proves it: a parse check, recruiter searches, and blind subagent tests. Every folder path comes from settings, so the shipped skill holds nothing about any one person. Finding roles on job boards is out of scope.

## User stories

1. As a job seeker, I want my CV rebuilt from Markdown in my own Word template's design, so the tailored CV looks like my current one.
2. As a job seeker, I want the CV's title name to parse as separate words, so a parser files me under my real name.
3. As a job seeker, I want to see what text a parser extracts from my PDF and Word files, so I can see what a recruiter's system sees.
4. As a job seeker, I want each ad term reported as found or missing in each file, so I add only the terms I can prove.
5. As a job seeker, I want to run a recruiter's Boolean searches on my old and new CV, so I can see which version they would find.
6. As a job seeker, I want one check that compares the parsed text with my Markdown source (name, contacts, headings, role dates, every paragraph, page count, no em or en dashes), so a silent parse fault cannot ship.
7. As a job seeker, I want my page one shuffled into piles of fictional competitor pages, with the key kept out of the readers' folder, so a blind reader judges it among rivals.
8. As a job seeker, I want the same seed to give the same piles, so a pile run can be repeated.
9. As a job seeker, I want my folders (job-hunting folder, baseline CV, output folder, confirmed facts file) set once in a settings file or environment, so no command needs my paths typed and the public skill holds none.
10. As an agent running the skill, I want every look-only step to be its own read-only command, so I can check freely without changing a file.
11. As an agent, I want a `doctor` command that names each missing external program and how to get it, so a run fails early and clearly.
12. As an agent, I want the blind-test steps in the skill, so every run uses the same tests and prompts.
13. As the maintainer, I want byte-identical outputs on a committed synthetic worked example, so a change that shifts output is caught by `bun run check`.

## Implementation decisions

### Layout

- Multi-module, stateful standalone skill CLI, as the repository's `AGENTS.md` requires for a CLI that writes files: modules under `src/cv-tailor/`, a `{ contract, setup }` factory `createCvTailorCli` in `src/cv-tailor/cli.ts`, listed in `.fallowrc.json` `"entry"`, built with `kind: "runtime-factory"` by `scripts/build-skill-clis.ts` into `skills/productivity/cv-tailor/dist/cli.mjs`. It stays off the front-door `src/commands.ts`.
- Add-ons: `"state"` and `"programs"` in `installedAddons`. The CLI starts its external programs (`pdftotext`, `pdfinfo`, `soffice`) through the programs add-on. The bundle targets Bun, so a user needs Bun, Poppler and LibreOffice.
- The one new program is the `cv-tailor` CLI itself. No hook, no second tool.

### Commands

Look-only work is its own inspect command, never a flag on a changing command (kernel ADR 0002, "look-only work is an inspect route"). Routes name the thing, then the action.

| Route | Kind | Replaces | Does |
| --- | --- | --- | --- |
| `doctor` | inspect | prerequisite checks in the shell script | Finds `pdftotext`, `pdfinfo` and `soffice`; names each missing one with its repair. |
| `settings show` | inspect | none | Prints each resolved folder and the source it came from. |
| `cv text <file> [--raw] [--page <n>]` | inspect | `text` | Parser text of a PDF (layout or raw) or a Word file (`word/document.xml`). |
| `term report --file <f>... --term <t>...` | inspect | `terms` | Found and missing terms per file. |
| `search run --file <f>... --query <q>...` | inspect | `search` | HIT or MISS per query per file, with absent and excluded terms. |
| `cv check --pdf <f> --docx <f> --source <f> [--max-pages <n>] [--term <t>...]` | inspect | `parse` and `all` | The parse checks; with `--term`, every term must be in both files. A FAIL is a refused station, exit code 1. |
| `cv build <source.md> [--template <docx>] [--out <folder>]` | changing, `repository-local` | shell build script and Markdown-to-Word script | Writes the `.docx`, then the `.pdf` through `soffice` with a private profile; reports the page count. |
| `pile make --tests <folder> --new <page> --old <page> [--runs <n>] [--seed <n>] [--replace]` | changing, `repository-local` | pile script | Writes `piles/pile-1.txt` onward and the key beside `piles/`, never inside it. |
| `pending` | inspect | none | The state add-on's report command: unfinished `cv build` or `pile make` runs. |

- `cv build` locks one resource, the output `.docx` path; `pile make` locks the tests folder. Each refuses to write over the template, and `pile make` refuses a non-empty `piles/` unless `--replace` is given.
- Repeatable options replace the prototype's `--` separator, because the kernel parses declared options only.

### Modules (each replaces a prototype script)

- `src/cv-tailor/settings.ts`: resolves folders and program paths. Replaces the shell script's path handling and its `soffice` search.
- `src/cv-tailor/cv/rules.ts`: pure. The Markdown CV shape (title, headline, contact lines, sections, roles, role date line, bullets, inline bold and links), the role date-range rule and the dash scan. Shared by `cv build` and `cv check`, so the two read the source the same way.
- `src/cv-tailor/docx/zip.ts`: reads and writes a zip with `node:zlib` (`inflateRawSync`, `deflateRawSync`, `crc32`).
- `src/cv-tailor/docx/template.ts`: opens the template, checks the seven required styles (`Title`, `Subtitle`, `ContactDetails`, `Heading 1`, `Heading 2`, `RoleDetails`, `List Bullet`, by name or style id), removes the Title style's character spacing, replaces the body before `w:sectPr`, and adds hyperlink relationships. Replaces the Markdown-to-Word script.
- `src/cv-tailor/cv/build.ts`, `cv/text.ts`, `cv/check.ts`: the three `cv` commands. Text extraction replaces `text`; `check.ts` replaces `parse` and `all`.
- `src/cv-tailor/search/rules.ts`: pure. Text normalising (NFKC, quote folding, joined hyphenated line breaks), whole-word term patterns with hyphen-or-space and trailing `*`, and the Boolean query parser (OR over AND over NOT over atom, adjacent atoms mean AND). `search/run.ts` and `term/report.ts` are its commands.
- `src/cv-tailor/pile/rules.ts`: pure. A seeded generator, distinct target positions while they last, and the pile and key text. `pile/make.ts` is its command.
- `src/cv-tailor/causes.ts`: the cause table.

### Word output and its dependency

- No new npm dependency. The repository depends only on `agent-cli-kernel` and `libphonenumber-js`, and Bun's `node:zlib` already offers raw deflate, inflate and CRC-32, so a small zip module covers read and write. It bundles into `dist/cli.mjs` like any source file. Open choice 1 offers `fflate` instead.
- The template is edited as text at named elements, not parsed into a document tree, so every part the build does not touch keeps its exact bytes.
- Deterministic `.docx`: entries in the template's order, each stamped with the fixed DOS time 1980-01-01 00:00, one fixed compression level, no extra fields, and file modes copied from the template. The same source, template and Bun version give byte-identical `.docx` files.
- What is not byte-identical: the PDF (LibreOffice stamps a creation date and producer), and any `.docx` compared with the prototype's (it stamps the wall-clock time on each zip entry and reserialises every XML part). Parity with the prototype is therefore proved on extracted text and check results, not on the `.docx` bytes.

### Settings

- Keys: `jobHuntingFolder`, `baselineCv` (the `.docx` used as template; its `.pdf` sits beside it), `outputFolder` (default: the source Markdown's folder), `factsFile` (the confirmed-facts file the skill reads for claims), and `soffice` (path to LibreOffice's program).
- Order, first hit wins: command option, then environment variable (`CV_TAILOR_JOB_HUNTING_DIR`, `CV_TAILOR_BASELINE_CV`, `CV_TAILOR_OUTPUT_DIR`, `CV_TAILOR_FACTS_FILE`, `CV_TAILOR_SOFFICE`), then the settings file.
- Settings file: `CV_TAILOR_SETTINGS_FILE` when absolute, else `xdgBaseFolder(env, "config")` from `agent-cli-kernel/xdg-base` joined with `nathanvale-skills/cv-tailor/settings.json`. It is read with `readRootedFile` from `agent-cli-kernel/rooted-file`.
- State folder: `CV_TAILOR_STATE_DIR` when absolute, else `$NATHANVALE_SKILLS_DATA_HOME/cv-tailor/state` when absolute, else the XDG data base joined with `nathanvale-skills/cv-tailor/state`, the same order as the Google Contacts ledger.
- An empty or relative value is ignored at every level. A command that needs a missing key refuses with a station naming the key and the three places to set it.

### The skill

- `SKILL.md` keeps the prototype's six steps (capture the ad, analyse fit, rewrite, screen like a recruiter, blind tests, deliver), rewritten with `writing-for-agents` for any candidate: claims come from the file at `factsFile`, a requirement without evidence is a **Gap**, the user sends every file and message, and the skill drafts only.
- `references/blind-tests.md` keeps the four blind tests: recruiter old versus new, pairwise style and positioning, hiring-manager follow-ups, and the pile test (eight fictional competitor pages, three runs with the new page, one with the old). Every prompt opens with the reader's role and the read-only-these-files line. Commands in both files name `cv-tailor` routes only.
- The skill appears in `.claude-plugin/plugin.json`, `plugin.json`, `package.json` `pi.skills`, `README.md` and `skills/productivity/README.md`. New domain words (Gap, evidence, pile, synthetic page) go into a skill glossary routed from `GLOSSARY-MAP.md`. A changeset covers the `src/` change.

### No legacy

Nothing carries the prototype's names forward: no `cv_check`, `make_piles`, `build_cv` or `md_to_docx` route or alias, no `parse` or `all` route, no `--force`, no `SOFFICE` variable, and no `renamedFrom` on any command. The prototype's own fate is open choice 3.

## Testing decisions

- Tests drive commands through `runInProcess` on the contract from `createCvTailorCli`, never through internal files, so modules can move.
- Pure rules (`cv/rules.ts`, `search/rules.ts`, `pile/rules.ts`) get table tests: query precedence, prefix terms, hyphen-or-space, joined line breaks, date lines, and pile positions.
- `soffice` is a programs add-on call; tests stand in a fake program that writes a fixed PDF, so `bun run check` never needs LibreOffice. The real conversion is proved by the maintainer check.
- PDF text needs `pdftotext` and `pdfinfo`. CI installs them (open choice 2); tests never skip when they are missing, they fail with the `doctor` repair.
- Prior art: `tests/google-contacts-*.test.ts` for a runtime-factory CLI, its XDG resolution test, and its PII guard.

### The synthetic worked example

Committed under `tests/fixtures/cv-tailor/`, written fresh for this repository: an invented candidate with an invented history, applying for an invented role at an invented employer. No line is copied or edited from any real CV or ad.

- `job-ad.md`: a numbered requirement list with terms the CV proves and terms it does not.
- `cv.md`: the tailored CV source in the Markdown shape, two pages, with one link that hides its URL (to raise a WARN).
- `template.docx`: a minimal Word template with the seven styles, its Title style carrying negative character spacing.
- `old.pdf` and `new.pdf`: built once with LibreOffice from the template and the source; `old.pdf` keeps the spacing fault.
- `synthetic/s1.txt` to `s8.txt`: eight fictional competitor first pages.
- `expected/`: the golden outputs. `cv.docx` from `cv build`; word text and layout and raw PDF text; term, search and check results as JSON data. The text and result goldens are captured once by running the prototype scripts on these synthetic files, so they prove parity, then frozen.

### Maintainer-only check

A private worked example the maintainer keeps locally is never committed and never named in the repository. Before acceptance the maintainer runs `cv build`, `cv text`, `cv check` and `search run` on it, compares the results with the prototype's outputs for the same files, and saves the command output to the coordination folder outside the repository.

## Acceptance checks

1. `bun run check` exits 0 on the branch.
2. `bun run build:skills` writes `skills/productivity/cv-tailor/dist/cli.mjs`; then `bun run check:skills` reports every bundle up to date, and `verify.ts ready`, `sweep` and `drive` from the kernel's verify-cli skill pass on that bundle.
3. Determinism test: `cv build` on the synthetic fixture, run twice into two scratch folders, gives two `.docx` files byte-identical to each other and to `expected/cv.docx`.
4. Parity test: `cv text` (word, layout, raw) and the data of `term report`, `search run` and `cv check` on the synthetic fixture are byte-identical to the prototype-captured goldens in `expected/`.
5. Name-fault test: `cv check` on `old.pdf` refuses with the name read as one word; on `new.pdf` it passes the name check.
6. Pile test: `pile make --seed 7` run twice gives byte-identical piles and key; the key sits outside `piles/`; the new page sits at a different position in each of the three new-page piles.
7. Settings test: `settings show` output shows option over environment over file, ignores empty and relative values, and `cv build` with no template set refuses naming `baselineCv`.
8. `bun test tests/skills.test.ts` passes with `cv-tailor` in all four manifests and both READMEs.
9. Privacy gate, both zero hits: agent-gates `history scan --range origin/main..HEAD --pattern-file <private-words file kept outside the repository>`, and a plain `git grep -i -f <the same file>` over the branch tree.
10. Maintainer-only check: on the private example, word text and layout PDF text from the new CLI are byte-identical to the prototype's, `cv check` passes, and every search verdict matches; the output is saved outside the repository.

## Open choices

1. Zip handling: an in-repository module on `node:zlib` (recommended: no new dependency, full control of bytes) or the `fflate` package (smaller own code, one new bundled dependency).
2. CI: add a `poppler-utils` install step to `.github/workflows/ci.yml` so PDF tests run there (recommended), or keep PDF tests local only (they would fail in CI).
3. The prototype branch and worktree: retire them once this skill is accepted (recommended; deleting them is the maintainer's decision).
4. Settings file location: the per-tool `CV_TAILOR_SETTINGS_FILE` plus XDG config (recommended), or a new suite-wide `NATHANVALE_SKILLS_CONFIG_HOME` like the data one.

## Out of scope

Finding or filtering roles on job boards; writing to any notes vault; sending, uploading or applying; a page-image command (the skill calls `pdftoppm` directly for the skim); bundle rules beyond today's `bun run build:skills` (see `docs/specs/cv-tailor-later.md`).
