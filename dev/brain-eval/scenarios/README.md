# Writing a scenario

A scenario is one JSON file in this folder: a story told as dated notes, and questions asked at points in the story. Everything in here is **invented**: real runs send these notes to a model provider, so never put real people, places or numbers in a scenario.

`REVIEW.md` shows the whole library on one page. Regenerate it after any change: `node dev/brain-eval/list.mjs > dev/brain-eval/scenarios/REVIEW.md` (a test fails if it is out of date).

## The file

```json
{
  "id": "medication-change",
  "title": "A medication change after a check-up",
  "description": "What the story tests, in a sentence or two.",
  "notes": [
    { "id": "n01", "at": "2026-01-05", "text": "GP prescribed Mum 2 x Tablet A a day." },
    { "id": "n10", "at": "2026-03-02T12:00", "text": "The GP changed it: Mum now takes 1 x Tablet B a day." }
  ],
  "questions": [
    {
      "id": "tablets-now", "kind": "override", "after": "n10",
      "ask": "What tablets does Mum take each day?",
      "must": [["1 x Tablet B"]],
      "stale": ["2 x Tablet A"],
      "why": "The change in note 10 overrides note 1."
    }
  ]
}
```

- **notes**: in time order, 10 to 40 of them, each with an id, a date (`2026-03-04`, or `2026-03-04T10:30Z`; a date alone means 09:00 UTC) and up to 8,000 characters of text. Write them like quick personal notes. Put the fact near the start of the note, because the brain files a short title and summary of each note.
- **questions**: each is asked *after* the note it names, as if the person asked then, so the model only knows the notes up to that point. `at` sets another time; by default it is an hour after the note.
- **kind** is one of:
  - `recall`: an earlier fact that must still be found. Needs `must`.
  - `override`: a later note replaced an earlier fact. Needs `must` (the new fact) and `stale` (the old one, which must appear in an earlier note than the new one).
  - `retract`: something was cancelled or taken back. Needs `must` (it says so); `stale` is the thing that must not be reported as still happening.
  - `multi`: several facts from different notes in one answer. Needs two or more `must` groups.
  - `distractor`: nothing in the notes answers it, so the right reply is "nothing relevant". Set `"expectNothing": true` and give no `must` or `stale`.
- **must** is a list of groups; each group is a list of alternative phrasings. An answer passes a group when it contains any one of them. **stale** is a list of phrases that must not be given as current.

## How answers are scored

By rules, not by another model. Text is lower-cased, numbers written as words become digits (`two times` and `2 x` are the same), and punctuation is ignored. A phrase counts only as whole words (`4 June` is not found in `14 June`, and `Tablet A` is not found in `Tablet Apple`). An answer passes when every `must` group is met and no `stale` phrase is given as current. A stale phrase in the same line as a word such as *no longer*, *instead of*, *previously* or *cancelled* counts as a mention of the old value, which is allowed.

## What makes a fair question

- It has an answer in the notes at its checkpoint (the checker refuses a question whose `must` is not in any note by then).
- An `override` is real: the stale phrase is in an earlier note than the new fact (also checked).
- The phrases are specific. `Tablet B` is a good phrase; `tablet` or `Mum` is not, because it would appear in nearly any answer.
- Give every reasonable wording as an alternative (`1pm`, `1 pm`, `13:00`), so a correct answer is not marked wrong for its style.
- A stale phrase should be something only the old value would say. If the old and the new value share words, use a longer phrase.
- A `distractor` must be about something clearly absent. Avoid a topic that a careful answer could reasonably connect to a note.
- Say in `why` what the question is meant to catch.

`npm run brain-eval -- --demo` runs everything free, with a stand-in model, to check a new scenario loads and runs; it says nothing about quality.
