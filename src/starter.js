'use strict';
// The instruction file everkeep init writes into a new vault.

const STARTER_TEXT = [
  '# This vault',
  '',
  'This folder is a notes vault, read and written through the Everkeep tools. Read this file at the start of every session.',
  '',
  '## Starting out',
  '',
  'The vault is new and has no structure yet. Do not ask the person to plan one.',
  '',
  '- In the first session, ask one question, in their language: what do they want to keep here first? Any answer will do, "not sure yet" included.',
  '- Start with two things: `inbox/` for anything not sorted yet, and `log.md` with one dated line per change you make.',
  '- Put new notes and dropped-in files into `inbox/` unless a folder for them already exists.',
  '- When three or more notes share a subject (a project, a person, a topic, a source type), propose a folder for it and move them there after the person agrees. Folders can sit side by side: projects, reference pages, sources.',
  '- Files the person drops in as sources (PDFs, mail, scans) are not edited; write what you learn from them in a separate note that links to the source.',
  '- When a folder needs a rule (for example "sources are read-only"), suggest it; write policies are set by the person on the Vault policies page or with `everkeep policy set`, not by you.',
  '- As folders appear, add one line per folder to a "Layout" section below, so the next session knows where things go.',
  '',
  '## Layout',
  '',
  '- `inbox/` — not sorted yet',
  '- `log.md` — one dated line per change',
  '',
  '## Always',
  '',
  '- Read before you write; edit with the rev you were given.',
  '- Discard with `trash_file`; nothing is deleted.',
].join('\n') + '\n';

module.exports = { STARTER_TEXT };
