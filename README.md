# Studying

A study app that lives inside Claude. You bring your course materials and your own cloud storage; Claude turns the materials into summaries, mind maps, flashcards and practice exams, grades your answers, and keeps a memory of what you still need to work on, one subject at a time.

It is an **MCP App**: a connector that opens a full-screen window in the Claude chat. You use the window and the chat together.

- **Your files stay yours.** Everything lives in a `Studying` folder in your Google Drive (MEGA and other storage connectors work the same way). This server stores none of it.
- **Claude is the brain.** Generating, reviewing, grading and remembering are all done by your own Claude, with your own plan.
- **Free and open source** (MIT).

## Install (two minutes)

1. In Claude, open **Settings → Connectors → Add custom connector**. Name it `Studying` and paste:
   ```
   https://studying.<account>.workers.dev/mcp
   ```
   (The exact address is shown on the server's home page.)
2. In the same place, connect **Google Drive** (or MEGA).
3. Start a chat and say:
   ```
   Open Studying
   ```
   The window opens full screen and walks you through setup: pick the storage, check the connection, Claude creates the workspace, then add your first subject.

### Install prompt

Paste this into a new chat after adding the connector:

> Open Studying and set me up. Use my Google Drive for storage. Create the Studying workspace if it does not exist, then help me add my first subject.

## What you can do

| In the window | What Claude does |
|---|---|
| **Files**: browse the subject folders, select materials | Lists the folder in your storage and opens files |
| **Create**: pick materials, outputs (summary, mind map, flashcards, quiz, practice test, tasks, study plan, cheat sheet, glossary, past-exam analysis), question types, count, difficulty, time and points | Generates, has a second pass review it, saves it to `generated/`, shows progress with a time estimate |
| **Study**: flashcards with spaced repetition, mind maps, notes | Saves your card progress and updates the subject memory |
| **Test**: single and multiple choice, true/false, fill in the blank, matching, ordering, open answers, practical tasks, code; timer | The window scores objective questions itself; Claude grades open answers against a rubric and saves the result |
| **Report a mistake** on any card, question or note | Fixes the item and records the lesson in the rules so it does not happen again |

Rules and lessons are plain Markdown files in `Studying/_rules/`, so you can read and edit them yourself. Tell Claude in the chat when something is wrong and it updates them.

### Workspace layout

```
Studying/
  _system/settings.json, stats.json
  _rules/generation-rules.md, question-types.md, grading-rubrics.md, lessons-learned.md
  Subjects/<Subject>/
    subject.md        exam format, dates, grading
    memory.md         weak topics, progress, what to do next
    <Part>/
      part.md
      materials/      your files
      generated/      decks, tests, mind maps, notes
      results/        graded tests
```

## How it works

```
 window (in Claude) ──sendMessage──▶ Claude ──▶ your storage connector (Drive, MEGA)
        ▲                               │
        └──── study_pull ◀── mailbox ◀──┘ study_push / study_progress
```

An app window can only call tools of its own server, so it cannot reach your Drive directly. Instead, the window sends a chat message, Claude does the work with your storage connector, and puts the result in a short-lived mailbox on this server. The window reads the mailbox only while it is waiting for something. A mailbox holds at most 20 messages and deletes itself two hours after the window was last used.

Tools: `study_open` (opens the window), `study_push` (send a result to the window), `study_progress` (progress bar), `study_guide` (the playbooks Claude follows: setup, storage layout, generation, question types, grading, review, fixer, memory, file formats, study flow), and `study_pull` (window only).

## Run your own server

The server is a Cloudflare Worker with one Durable Object. It fits in the free Workers plan and needs no database, KV or card.

```bash
npm run dev      # builds the window and starts wrangler dev on http://localhost:8787
npm test         # builds and runs the tests
npm run deploy   # deploys with your Cloudflare login
```

Deploys from GitHub run automatically on every push to `main` once the repository has two secrets:

- `CLOUDFLARE_API_TOKEN`: a token with the **Edit Cloudflare Workers** template
- `CLOUDFLARE_ACCOUNT_ID`: your account id (Workers dashboard, right side)

Project structure: `app/window.src.html` is the window, `scripts/build.mjs` inlines the MCP Apps SDK into it, `server/src/` is the Worker, `tests/` runs the Worker under Node.

## Privacy

No accounts, no tracking, no files. See [`/privacy`](server/src/privacy.html).

## License

MIT
