# Blind tests

Each test runs in a fresh subagent that reads only the files named in its prompt so it judges the CV rather than this conversation. Launch independent tests in parallel.

## Inputs

Place inputs in `<work>/tests/`:

- `job-ad.md`: a copy of the captured ad.
- `cv-old.txt`: `cv text <baseline pdf>` output.
- `cv-new.txt`: `cv text <tailored pdf>` output.

Open every subagent prompt with the reader's role, followed immediately by this line:

> Read ONLY these files and nothing else (do not search the filesystem, do not open other files in these folders, no web):

## 1. Recruiter, old versus new

Run two subagents with identical prompts except the CV file (`cv-old.txt` vs `cv-new.txt`). Role: an experienced contract recruiter filling this role. Ask:

- For each numbered requirement in the ad: Proved, Partly, or Not shown, quoting the convincing CV phrase (15 words at most) or "none".
- Shortlist of five to send the client: Yes or No, with one sentence why.
- After a 10-second skim of page one, what role is this candidate targeting?
- Top three hesitations.

Record requirement counts, shortlist decision, and skim answer side by side (old versus new).

## 2. Pairwise style and positioning

Run one subagent on `<work>/tests/pairwise.md` containing two labelled versions (X and Y) of the three strongest bullets (method-first versus outcome-first) and of the headline plus profile (two distinct framings). Ask which requirements each version proves, which it prefers in a stack, and which makes it more likely to call, with reasons. Keep the winner.

## 3. Hiring manager follow-ups

Run one subagent playing the client's hiring manager on `job-ad.md` and `cv-new.txt`. Ask for the sharpest follow-up question for each profile sentence and bullet (quoting the first six words), plus up to five claims hardest to verify and why.

Resolve each question from `factsFile`:

- Claim with no source: rewrite or cut the bullet.
- Claim broader than the evidence: tighten the wording.
- Depth question the candidate answers from memory: add to the call talking points.

## 4. Pile test

1. Have one subagent write eight clearly fictional competitor **synthetic pages** for the ad to `<work>/tests/synthetic/s1.txt` through `s8.txt`: two strong fits, three mixed seniors, one specialist strong on the ad's rarest skill but light on the core stack, one adjacent-discipline engineer, and one keyword-stuffed CV. Use fictional names and generic employers only.
2. Extract page one of both CVs with `cv text <pdf> --page 1` into `<work>/tests/old-p1.txt` and `<work>/tests/new-p1.txt`.
3. Build the shuffled **piles** and external key:

```sh
bun <skill-dir>/dist/cli.mjs pile make --tests "<work>/tests" --new "<work>/tests/new-p1.txt" --old "<work>/tests/old-p1.txt"
```

This writes `piles/pile-1.txt` through `piles/pile-4.txt` (three runs with the new page at distinct positions, one with the old) and writes `pile-key.txt` beside `piles/`, never inside it.
4. Launch four subagents, one per pile, each given `job-ad.md` and its single pile file only (never `pile-key.txt`). Role: a busy recruiter with about 10 seconds per CV. Ask for a shortlist of exactly three candidates in order, and a one-line reason for every skipped candidate.

Record the new CV's shortlist rate across the three runs, the old CV's result, and every skip reason. Fix presentation reasons; report missing-experience reasons as Gaps for the candidate. Keep synthetic pages inside `tests/` as fictional test material only.
