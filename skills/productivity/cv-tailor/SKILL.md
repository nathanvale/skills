---
name: cv-tailor
description: Tailor a candidate's CV to one job ad from confirmed evidence and prove it with parse, recruiter-search, and blind reader tests through the cv-tailor CLI. Use when asked to tailor, rewrite, or screen-test a CV for a specific role.
---

# CV tailor

Turn one job ad into a CV the candidate can defend in interview, and prove it beats the baseline CV with tests rather than opinion. Every claim comes from confirmed **evidence**; a requirement without evidence is a **Gap**, named in the call notes and left out of the CV. Draft only: the candidate decides whether to apply and sends every file and message.

Run the bundled CLI with `bun <skill-dir>/dist/cli.mjs <route>`. Inspect routes (`doctor`, `settings show`, `cv text`, `term report`, `search run`, `cv check`, `pending`) never modify files. Run `doctor` and `settings show` first so missing programs or paths fail early.

## Settings

Resolve all paths from `settings show` (option > environment > `$XDG_CONFIG_HOME/nathanvale-skills/cv-tailor/settings.json` or `CV_TAILOR_SETTINGS_FILE`):

- `jobHuntingFolder`: root where this role's work folder `<Agency>-<Role>-<YYYY-MM-DD>/` lives.
- `baselineCv`: template `.docx` used by `cv build`; its baseline `.pdf` sits beside it.
- `outputFolder`: optional build output folder (defaults to the Markdown source's folder).
- `factsFile`: confirmed-facts file that authorizes every claim, title, and date.
- `constraintsFile`: optional rate, location, and contract limits to check the ad against.
- `soffice`: path to LibreOffice's `soffice` binary when not on `PATH`.

## Steps

### 1. Capture the ad

Save the full ad text to `<work>/job-ad.md` with read time, posting age, applicant count, rate, contract length, work arrangement, recruiter, and any clearance or work-rights line. Platform match summaries are not the ad.

Done when every requirement line is saved verbatim and numbered.

### 2. Analyse the fit

Write `<work>/step-1-analysis.md`:

- **Requirement matrix:** each numbered requirement in the ad's words, the strongest confirmed evidence from `factsFile`, and Strong, Medium, Light, or Gap.
- **Keyword gap:** run `term report --file <baseline pdf> --term <t>...`. Mark each missing term Supported (evidence exists in `factsFile`) or Gap.
- **Red flags:** headline mismatch, missing must-haves, title drift, unexplained date overlaps, length, or constraint conflicts from `constraintsFile`. Give each a fix or flag it for the candidate.

Done when every requirement has a fit rating and every Gap is named.

### 3. Rewrite and build

Write `<work>/<Candidate>-<Role>.md` in the Markdown CV shape (`# Name`, headline line, contact lines, `## Section`, `### Role, Employer`, `<Month YYYY to Month YYYY|present> | <place>`, `- bullet`, normal paragraphs; inline `**bold**` and `[text](url)` only; no heading deeper than `###`):

- Lead headline and profile with the ad's top must-haves.
- Give each Strong or Medium must-have its best evidence as a method-first bullet (verb, what, how in the ad's exact terms, checkable outcome). Cut bullets that serve no requirement.
- Keep each ad term in the bullet that proves it; keep Gaps out.
- Scope claims accurately and keep confirmed titles and dates unchanged.
- Fit two A4 pages by cutting lower-value lines, keeping the template's font sizes intact.
- Use full stops, commas, colons, and "to" for ranges (no em dash U+2014 or en dash U+2013).

Build and verify:

```sh
bun <skill-dir>/dist/cli.mjs cv build "<work>/<Candidate>-<Role>.md"
bun <skill-dir>/dist/cli.mjs cv check --pdf "<work>/<Candidate>-<Role>.pdf" --docx "<work>/<Candidate>-<Role>.docx" --source "<work>/<Candidate>-<Role>.md" --term <Supported term>...
```

`cv build` resets the template Title style's character spacing so `pdftotext -raw` reads the candidate's name as separate words.

Done when `cv check` exits 0 (PASS) and every WARN is fixed or accepted with a reason.

### 4. Screen like a recruiter

- **Searches:** write two or three recruiter Boolean queries for the ad and run `search run --file <baseline pdf> --file <new pdf> --file <new docx> --query '<q>'...`. Fix any MISS on a Supported term; leave MISS on a Gap.
- **Visual skim:** run `pdftoppm -png -r 80 -f 1 -l 1 <new pdf> <work>/page-1` and inspect the image so the role-matching headline sits in the top fifth and titles and dates are easy to scan.

Done when every query hits except on Gaps and the page-one image passes the skim.

### 5. Run the blind tests

Follow [blind-tests.md](references/blind-tests.md). Apply every fix the results support, rebuild, and re-run steps 3 and 4.

Done when the blind recruiter shortlists the new CV and the pile test shortlists it in at least two of three runs, or the only remaining skip reasons are Gaps only the candidate can close.

### 6. Deliver

Write `<work>/results.md`:

1. Old versus new tables for every check, search, and blind test.
2. **Claims trace:** every new or changed sentence, its source in `factsFile`, and Confirmed, Evidenced, or Unsupported. Remove every Unsupported sentence before delivering.
3. A short recruiter note and three or four call talking points.
4. Open decisions for the candidate, one line each with a recommendation (whether to apply, Gaps to confirm, title choices, overlaps, and any baseline parse fault).

Hand the candidate the PDF and `results.md`. Wait for explicit approval before any upload, message, or external submission.
