# Glossary Map

## Contexts

- [Skills plugin](./GLOSSARY.md): Claude Code coordinator session hooks and shared coordination state
- [Google Contacts](./skills/in-progress/google-contacts/GLOSSARY.md): address book auditing, evidence-backed enrichment, duplicate merging, and safe mutation planning for Google Contacts
- [CV Tailor](./skills/productivity/cv-tailor/GLOSSARY.md): evidence-backed CV tailoring, Gap tracking, recruiter Boolean screening, and blind Pile testing with Synthetic pages

## Relationships

- **Skills plugin ↔ Google Contacts**: Independent bounded contexts with no shared storage or vocabulary. **State folder** belongs exclusively to the Skills plugin context, while **Contact ledger** (`GOOGLE_CONTACTS_LEDGER_DIR`, or `google-contacts/ledger` under the **Suite root** `$NATHANVALE_SKILLS_DATA_HOME`, `$XDG_DATA_HOME/nathanvale-skills` or `$HOME/.local/share/nathanvale-skills`) belongs exclusively to Google Contacts so their directories and environment variables never collide.
- **External vocabularies**: `agent-cli-kernel` (`changing.md`) also uses the phrase "state folder" to mean a host command's `State add-on` root directory and calls an unconfirmed started transaction an `unresolved case`. Inside the Google Contacts bounded context, those two concepts are always named **Contact ledger** and **Unfinished mutation**. Contract terms (`Command`, `Station`, `Cause row`, `Handoff`, `Effect class`, `State add-on`, `Programs add-on`) are owned by `agent-cli-kernel`, and software design terms (`Module`, `Interface`, `Seam`, `Adapter`, `Depth`, `Leverage`, `Locality`) are owned by `codebase-design`.
