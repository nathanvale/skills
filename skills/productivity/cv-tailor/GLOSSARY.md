# CV Tailor Glossary

Domain vocabulary for the `cv-tailor` skill and standalone CLI.

- **Evidence**: A confirmed record in the candidate's `factsFile` (or linked source note) that substantiates a CV claim, title, date, or outcome.
- **Gap**: A job-ad requirement or keyword that lacks confirmed **Evidence** in `factsFile`. Gaps stay out of the tailored CV and are named explicitly in analysis and delivery notes.
- **Pile**: A shuffled stack of candidate page-one extracts (`pile-1.txt` onward, each headed `===== CANDIDATE C<k> =====`) mixing one target CV page with fictional competitor **Synthetic pages** for blind recruiter shortlisting. Its mapping key (`pile-key.txt`) sits outside `piles/`.
- **Synthetic page**: A clearly fictional competitor first-page CV (`synthetic/s1.txt` through `s8.txt`) generated with invented names and generic employers solely to test how a tailored CV competes in a **Pile**.
