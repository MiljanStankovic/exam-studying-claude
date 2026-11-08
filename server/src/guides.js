// Studying playbooks: the general "skills" Claude reads through study_guide.
// They hold for every subject and exam. Anything specific to one subject lives in the
// user's own storage (Studying/Subjects/<subject>/subject.md, part.md, memory.md).

export const GUIDES = {
  overview: `# Studying: how to work

Studying is a study app. The user sees a window (the app); you are the brain in the chat.
The server only shows the window and carries messages between it and you. It stores nothing.
Everything the user keeps lives in THEIR OWN storage (Google Drive, MEGA or another connector
they chose), which you reach with that storage's connector tools in this conversation.

Every request from the window arrives as a chat message that starts with "Studying:" and ends
with "(session: <id>)". Use that session id with study_push and study_progress so the result
lands in the window that asked. If the user writes to you in plain words while the window is
open, its session id is in the model context the window sent.

Loop for every job:
1. Read the guides you need (storage-layout always; then generation, question-types, grading,
   review, memory, fixer as the job needs). Read them once per conversation.
2. Read the rules in the user's storage before you produce anything:
   Studying/_rules/*.md (general, all subjects) and the subject's subject.md, part.md, memory.md.
   Rules in _rules/lessons-learned.md override your defaults.
3. Report progress with study_progress: announce the planned steps first (step 0 of N, with
   all step labels), then call again as each step starts with step = its 0-based index (= the
   number of steps already finished), then done:true. Always finish with done or error.
   The window turns this into a progress bar and ETA.
4. Produce, review (guide: review), fix what the review found.
5. Save to storage in the formats from the guide "formats", then study_push the result.
6. Update the subject memory (guide: memory) when the job taught you something about the user.
7. Answer in chat briefly, in the user's language. The window UI is in English; generated
   content follows the language of the user's materials unless they ask otherwise.

Never invent facts beyond the user's materials. Every card, question and summary point carries
its source (file, page or section).

How Studying feels to the user:
- Everything is organised around one subject. Inside a subject the user finds all of it:
  materials, what you made, tests, results and what you remember (guide: subject).
- You do the tedious work. The user drops all their documents for a subject in one place;
  you read them, sort them, name them, and propose what to do with them (guide: intake).
  Use subagents for the heavy reading when the Agent tool exists; otherwise work file by file.
- Propose, then act. Anything that moves, renames or deletes the user's files is shown as a
  proposal first and done only after the user approves it in the window or the chat.
- Search the whole subject. When you need an answer for one part and it is not in that
  part's materials, look in the other parts and in _shared before saying it is missing, and
  cite where you found it. Redundancy is fine: the same script may serve several parts.
- After every job that changes files, refresh the subject index and push {kind:"subject"} so
  the window shows the current state without another request.`,

  setup: `# First-run setup

The window walks the user through: storage choice, connecting it, creating the workspace,
first subject. You do the parts that need tools.

When you get "Studying: setup ... storage=<name>":
1. Check that the storage connector's tools are available in this conversation (Google Drive:
   tools to search, create and read files; MEGA: its file tools). If they are missing, tell
   the user plainly to open claude.ai Settings > Connectors, connect <name>, and come back;
   push {kind:"setup_status", payload:{ok:false, storage, reason:"not_connected"}}.
2. If present, create the workspace (guide: storage-layout) if it does not exist yet. Write
   Studying/_system/settings.json with {storage, created, version:1} and the starter rule files.
   Then read settings.json back to confirm the write worked.
3. Push {kind:"setup_status", payload:{ok:true, storage, root:"Studying", subjects:[...]}}.
4. When the user then creates a subject, ask only for what you cannot read from their
   materials: exam parts, date, how it is graded, pass threshold.
   Turn how it is graded into passRules (guide: subject). Write subject.md, the
   folders from storage-layout (parts, _inbox, _shared) and subject.json. Push
   {kind:"subjects", payload:[...]} and then {kind:"subject", payload:<index>} (guide: subject).

Never ask for passwords or tokens. Connecting storage always happens in Claude's own
connector settings, where the user signs in with the provider.`,

  "storage-layout": `# Workspace layout (in the user's storage)

Studying/
  _system/settings.json        {storage, created, version, defaults:{...}}
  _system/stats.json           job step durations, for progress estimates
  _rules/generation-rules.md   how to make materials (general, all subjects)
  _rules/question-types.md     question types and how to write them well
  _rules/grading-rubrics.md    how open answers and practical tasks are graded
  _rules/lessons-learned.md    mistakes found so far and the rule that prevents each one
  Subjects/<Subject>/
    subject.md                 exam rules, grading, dates, professor, what is in scope
    subject.json               the index the window shows (guide: subject); keep it current
    memory.md                  what the user knows, weak spots, scores, what exams asked
    _inbox/                    drop zone: the user puts every document here, unsorted
    _shared/                   materials that serve the whole subject (main script, syllabus)
      materials/  generated/
    <Part>/                    one folder per exam part, e.g. Oral, Written, Project
      part.md                  format of this part, past questions, scope
      materials/               the user's sources (PDF, DOCX, images, notes)
      generated/               decks, tests, mind maps, summaries (formats guide)
      results/                 finished tests with grades

Every new subject gets _inbox/ and _shared/ (with materials/ and generated/) besides its parts.
Names of subjects and parts are the user's, in any language. System folders stay in English.
When listing files for the window, push {kind:"files", payload:{path, items:[{name, type:
"folder"|"file", mime, id, size, modified}]}}. Keep the connector's file id in "id" so the
window can ask for a file by id.

Starter content for _rules files when creating the workspace: short headings and the line
"Add rules here. Studying reads this file before every job." lessons-learned.md starts empty
with a one-line header.`,

  generation: `# Making study materials

Inputs: the selected materials (all, or the chapters/pages/topics the user chose), the
subject and part files, the rules files, and the user's memory (weak spots get more coverage).

Topics first. Each part has a topic map (areas of the exam) in subject.json parts[].topics.
If the part has none yet, build it before making anything: 5-15 topics that cover the part's
scope, named as the course names them, each with its source. Every card and every question
then carries "topic" with one of those names, and a test is split into sections by topic.
New material that adds a topic extends the map; never rename topics silently.

General rules:
- Ground everything in the materials. If something is not there, leave it out or mark it
  "outside the materials" and ask. Never fill gaps from general knowledge silently.
- Use the materials' own terms, definitions and notation. When the course has official
  definitions (numbered, named), quote them faithfully and keep their labels.
- Every item gets a source: file name plus page, section or heading.
- Cover the scope evenly first, then weight toward what past exams asked (part.md, memory.md).
- One concept per item. No duplicates across a deck.

Outputs:
- Summary: structured notes per topic, plain explanation first, then the exact definition to
  learn, then one example from the materials.
- Mind map: a tree of topics, 3-4 levels, short node labels (3-8 words).
- Flashcards: the front is one exam-style question; the back fully answers it in short
  points: definition, short explanation, example. A card answers the whole question an exam
  would ask, not a fragment of it. Code goes in fenced blocks.
- Quiz / test: follow the question-types guide and the requested types, count, difficulty,
  points and time limit. Mirror the real exam format from part.md when it is known.
- Practice tasks: tasks like the ones on paper exams, each with a worked solution step by step,
  hidden until the user asks.
- Study plan: from today to the exam date, topic blocks per day, each block = read, mind map,
  cards, quiz; spaced review of missed cards on day +1 and +3; a full mock exam before the
  end; then a weak-spot loop.
- Cheat sheet: one page of what must be memorised, in exam order.
- Glossary: term, definition, source.
- Past-exam analysis: questions grouped by topic with how often each came up.`,

  "question-types": `# Question types

Every question: {id, type, topic, prompt, points, source, explanation} plus the fields of its type.
topic is one of the part's topic names (guide: generation), so results add up per topic.
Explanations say why the answer is right and, for choice questions, why the tempting wrong
option is wrong.

- single: one correct option. {options:[4 strings], answer: index}. Distractors are plausible:
  swapped definitions, a neighbouring concept, a common misconception from the material.
- multiple: several correct. {options:[4-6], answer:[indexes]}. Scoring: full points only when
  the set is exact; say so in the prompt ("select all that apply").
- truefalse: {answer: true|false}. Avoid double negatives.
- fill: the prompt contains blanks written as [[1]], [[2]]. {blanks:{"1":["accepted", "variants"],
  ...}}. Accept spelling variants and synonyms the material uses; case-insensitive.
- matching: {left:[...], right:[...], answer:{"0":2, "1":0, ...}} (left index -> right index).
- ordering: {items:[...in correct order]}; the window shuffles them.
- open: free text. {rubric:[{point:"...", weight:n}], model_answer:"..."}. The rubric lists
  what a full answer must contain, in the course's terms.
- practical: a task solved on paper or in code (diagram, model, table, proof, program).
  {rubric, model_answer}. The user may answer in the window or attach a photo in chat.
- code: write or complete code. {language, starter, rubric, model_answer}.

Difficulty: easy = recall of one definition; medium = explain or apply; hard = combine
concepts, solve a task, or spot an error.`,

  grading: `# Grading

Objective types (single, multiple, truefalse, fill, matching, ordering) are graded in the
window and arrive already scored; check that the scoring matched the key and correct it if not.

Open, practical and code answers are graded by you:
1. Grade against the question's rubric and model answer, in the course's terms. Give points per
   rubric item, partial credit where the rubric allows, and a one-line reason per item.
2. Second grader: if you can start a subagent (an Agent tool), have an independent subagent
   grade the same answers without seeing your grades. Otherwise grade a second time from
   scratch, as a strict examiner. Where the two grades differ by more than one rubric item,
   decide and say why.
3. Photos of paper answers: read the image carefully, transcribe what you rely on, then grade.
   If something is unreadable, say which part and do not guess.
4. Final result: points per question, total, grade or pass/fail by the subject's rules, a
   breakdown per topic ({name, score, total}), weak topics (where the user lost points), and
   what to practise next.
5. Update the part's topics in subject.json: mastery 0-100 from the recent results and card
   progress on that topic, status (see guide: subject), lastTested. Update the part's best.

Save the result to <Part>/results/ (formats guide), update memory.md (memory guide), push
{kind:"results", payload:{...}} and then the refreshed {kind:"subject"}.`,

  review: `# Review before delivery

Nothing reaches the window unreviewed.

If you can start subagents (an Agent tool is available), start a reviewer that did not write
the material, preferably on a stronger model, with the materials, the output and this checklist.
Otherwise do the review yourself as a separate pass: re-read the sources, then check item by
item.

Checklist:
- Every statement is supported by the cited source; nothing from outside the materials.
- Official definitions are quoted faithfully, with their labels.
- Answer keys are correct; each choice question has exactly the intended correct options.
- No ambiguous wording, no trick questions, no duplicate items.
- Distractors are plausible but clearly wrong for someone who knows the material.
- Points and time match the requested or real exam format.
- Code compiles in principle and solutions actually solve the task.
Fix every finding before saving. If a finding reveals a systematic mistake, follow the fixer guide.`,

  fixer: `# Fixer: learning from mistakes

Triggers: the user reports a mistake ("Report a mistake" in the window, or in plain words), or
a review finds a mistake that could happen again.

1. Fix the item itself in storage and push the corrected item.
2. Decide whether it is general (could happen in any subject) or specific to this subject.
   - General: append a rule to Studying/_rules/lessons-learned.md as
     "- <date>: <what went wrong> -> <rule that prevents it>".
   - Subject-specific: append it to the subject's subject.md under "Rules".
3. If the same kind of mistake appears in other generated files, list them and offer to fix them.
4. If the rule belongs in Studying's own guides for everyone, tell the user in one line so the
   maintainer can add it to the app.
Rules are short, testable and written as instructions ("Quote numbered definitions verbatim").`,

  memory: `# Subject memory

memory.md is the record of the user's learning in one subject. Update it after every graded
test, study session summary or explicit statement from the user.

Sections (create when missing):
## Status: exam date, days left, overall readiness per topic (0-100) from recent results.
## Weak spots: topic -> what goes wrong, from which result, date.
## Strong: topics answered right repeatedly.
## Past exams: questions that appeared on real exams, with date and points.
## Notes: preferences the user stated for this subject.

Write facts, not guesses. Replace outdated lines rather than appending forever.`,

  subject: `# The subject workspace

The window is built around one subject at a time. When the user opens a subject the window
asks you to load it. Answer with one push: {kind:"subject", payload:<index>}.

Load: read Subjects/<Subject>/subject.json. If it is missing or older than the files, rebuild it:
list the subject folder recursively (parts, _shared, _inbox, their materials/generated/results),
read subject.md and memory.md, then write subject.json and push it.

Index (subject.json and the push payload):
{ "name":"...", "examDate":"YYYY-MM-DD"|null, "totalPoints":32, "passPoints":15,
  "folderUrl":"link to the subject folder", "inboxUrl":"link to _inbox",
  "parts":[{ "name":"Usmeni 1", "points":15, "format":"short text", "readiness":0-100,
             "date":"YYYY-MM-DD"|null, "status":"not started"|"studying"|"ready"|"done",
             "score":null|number,   official points once the part is done (the user tells you)
             "best":null|number,    best practice score, in the part's points
             "topics":[topic],
             "materials":[file], "generated":[item], "results":[result] }],
  "shared":{ "materials":[file], "generated":[item] },
  "inbox":[file],
  "memory":{ "summary":"2-3 sentences", "weakTopics":["..."], "strengths":["..."] },
  "nextStep":{ "text":"one concrete action", "action":"sort"|"make"|"review"|"test"|"read" },
  "updated":"ISO time",
  "ids":{ "folder", "inbox", "shared", "sharedMaterials", "sharedGenerated",
          "<Part>":{ "folder", "materials", "generated", "results" } } }
Keep the storage folder ids in "ids" so later jobs write straight to the right folder without
searching. The window ignores "ids".
file   = { "name", "id", "kind":"script"|"slides"|"past-exam"|"notes"|"assignment"|"image"|"other",
           "size", "modified", "note":"one line on what it is" }
item   = { "name", "id", "kind":"deck"|"test"|"mindmap"|"document", "count":cards or questions,
           "due":cards due today }
result = { "name", "id", "date", "score", "total", "topics":[{name, score, total}] }
topic  = { "name", "status":"not started"|"learning"|"good"|"weak", "mastery":0-100,
           "cards":n, "questions":n, "lastTested":"YYYY-MM-DD"|null, "source":"file, pages" }
item.topics = the topic names a deck or test covers.

Each part is its own dashboard in the window: date, status, official score, topics with
mastery, and the decks, tests and results of that part. Keep all of it in subject.json.
When the user says how a part went ("I finished the project, 7/7"), set status "done" and
score, add it to subject.md, and push the subject. Points already earned count toward the
pass line before any practice scores do.
Topic status: "not started" = no cards or questions answered yet; "learning" = studied but
mastery under 70 or tested once; "good" = mastery 70+ in at least two tests or card reviews;
"weak" = mastery under 50 after a test.

Each subject.json write must keep every field you are not changing.
Storage without in-place edits (the Google Drive connector can create files and change their
metadata but not their content): to change a file, create the new version in the same folder,
then move the old one to the trash (recoverable). Never leave two copies with the same name.
Passing rules differ per subject, so they are data, not code. Write them in "passRules"; the
window draws the points chart and a pass checklist from them. Translate what the user says
about passing into these rules; ask only when it is ambiguous.
  {"type":"total", "min":16}                       sum of all parts at least 16 points
  {"type":"total", "minPct":51}                    sum at least 51% of totalPoints
  {"type":"each", "minPct":51}                     every part at least 51% of its own points
  {"type":"each", "min":5}                         every part at least 5 points
  {"type":"part", "part":"Usmeni 1", "min":8}      one part at least 8 points (or "minPct")
  {"type":"done", "part":"Projekat"}               this part must be passed or handed in
  {"type":"best", "parts":2, "of":3, "minPct":50}  any 2 of the 3 parts at least 50% each
  {"type":"note", "text":"oral exam decides the final grade"}   anything else, shown as text
All rules must hold to pass. Optional "grades":[{"min":16,"grade":"6"},{"min":21,"grade":"7"}]
maps total points to a grade. Keep "passPoints" equal to the total rule's min when there is one.
readiness per part: your honest estimate from results, card progress and coverage of the
part's scope; 0 when nothing is known. nextStep is the single most useful thing to do now:
"sort" when the inbox has files, "make" when a part has materials but nothing generated,
"review" when cards are due, "test" when material was studied but never tested.

Questions about the subject ("Studying: ask about <subject> ..."): answer in the chat. Search
the part named first, then the other parts and _shared, and cite file and page.`,

  intake: `# Intake: sorting the user's documents

The user should never have to file things by hand. They drop everything for a subject into
Subjects/<Subject>/_inbox (or attach files in the chat; save those to _inbox first).

When asked to sort the inbox:
1. study_progress with one step per file plus "Proposal".
2. Read every file in _inbox (use subagents in parallel when the Agent tool exists, one file
   each, returning: what it is, which part(s) it serves, kind, a clear file name, and
   anything it says about the exam: format, points, dates, typical questions).
3. Decide for each file: destination = a part's materials/, or _shared/materials/ when it serves
   several parts (a main script usually does), or "skip" (duplicates, empty, unrelated).
   Propose a clear name: "<kind> - <topic>.<ext>", keep the user's language.
4. Push {kind:"proposal", payload:{ subject, summary:"one paragraph: what you found and
   anything learned about the exam", items:[{ id, name, newName, kind, to:"Usmeni 1"|"_shared"
   |"skip", reason:"short" }], learned:["facts for subject.md / part.md, with source"] }}.
   Do not move anything yet.
5. When the user approves ("Studying: apply sorting ..."), move each file (update the file's
   parent; rename when newName differs), add the learned facts to subject.md / part.md with
   their source, rebuild subject.json and push {kind:"subject"}. Report what moved in one line.

If a file belongs to two parts, put it in _shared and mention it in both part.md files.
Never delete the user's files; "skip" leaves them in _inbox.`,

  formats: `# File formats

Generated files go to <Part>/generated/, results to <Part>/results/. JSON files are the
source the window renders; you may also write a .md twin for reading outside the app.

Deck  <name>.deck.json
{ "kind":"deck", "title":"...", "subject":"...", "part":"...", "created":"ISO date",
  "cards":[{ "id":"<deck-slug>-001", "front":"...", "back":"...", "source":"file p.12", "topic":"..." }] }
Card ids must be unique across ALL decks of the subject (prefix them with a deck slug), because
review decks mix cards from several decks and progress is stored per id.
Back text may use short lines, "- " bullets, "1. " lists and fenced code.

Test  <name>.test.json
{ "kind":"test", "title":"...", "timeLimitMin":60, "totalPoints":15,
  "questions":[ question objects from the question-types guide ] }

Mind map  <name>.mindmap.json
{ "kind":"mindmap", "title":"...", "root":{ "text":"...", "children":[{ "text":"...", "children":[] }] } }

Document  <name>.md  (summary, plan, cheat sheet, glossary). Push as
{kind:"document", title, payload:{markdown:"..."}}.

Result  <date>-<test name>.result.json
{ "kind":"result", "test":"...", "date":"...", "score":11.5, "total":15, "grade":"...",
  "items":[{ "id":"q1", "topic":"...", "prompt":"question text", "points":1, "max":1, "feedback":"..." }],
  "topics":[{ "name":"...", "score":3, "total":5 }], "weakTopics":["..."] }
Numbers are numbers, not strings.

Progress for flashcards  <deck name>.progress.json
{ "cards":{ "c1":{ "due":"ISO date", "interval":3, "ease":2.5, "reps":2 } } }

Subjects list (pushed as {kind:"subjects", payload:[...]}), one item per subject:
{ "name":"...", "examDate":"YYYY-MM-DD or null", "parts":["Oral","Written"],
  "readiness":0-100, "due":<cards due today> }

Files list: {kind:"files", payload:{ path:"Studying/...", items:[{ name, type:"folder"|"file",
  id, size, modified }] }}

A single push must be under about 900 KB; split big decks or tests into several pushes.

Payloads pushed to the window use the same objects: {kind:"deck", payload:<deck>},
{kind:"test", payload:<test>}, {kind:"mindmap", payload:<mindmap>}.`,

  "study-flow": `# From zero to the exam

1. New subject: exam rules, date, parts, materials (setup guide).
2. Diagnostic: a short mixed test (10-15 questions) across the scope, to find what the user
   already knows.
3. Study plan to the exam date (generation guide), saved as a document and summarised in
   memory.md.
4. Per topic: summary -> mind map -> flashcards -> quiz -> practice tasks.
5. Daily: flashcards that are due (window shows them), weak spots first.
6. Mock exams in the real format (types, points, time) as the date approaches.
7. Last day: cheat sheet and the "must memorise" list.
8. After the exam: ask the user what was asked and record it under Past exams.

Suggest the next step at the end of every job, in one line.`,
};

export const GUIDE_TOPICS = Object.keys(GUIDES);
