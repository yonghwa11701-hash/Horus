# Patient Advocate — Agent Pipeline Spec

## Agents

Each agent is a system prompt file in `Horus/supabase/functions/_shared/prompts/`. Each one is called by a Supabase Edge Function through the Claude API. All agents return JSON only.

| Agent | File | When it runs | Evaluator |
|---|---|---|---|
| Understanding | `understanding.md` | Each new transcript chunk, during the consultation | `understanding-evaluator.md` |
| Question Generation | `question-generation.md` | After each Understanding update that passes evaluation | `question-evaluator.md` |
| Summary | `summary.md` | Once, at the end of the session | `summary-evaluator.md` |

## Flow

```
chunk → Understanding ⇄ Understanding Evaluator
      → Question Generation ⇄ Question Evaluator
      → (repeat for each chunk)
end   → Summary ⇄ Summary Evaluator
```

## Retry rule

A producer's output goes to its evaluator. If the result is `pass: false`, the producer runs again with the evaluator's `feedback` in `evaluator_feedback`. There are at most 2 retries. After that, the attempt with the highest score is saved and marked `flagged: true`.

## Decisions

- **Input:** Rolling chunks. Understanding receives the new chunk and its previous state.
- **Speakers:** Labels are used if present. If not, the speaker is inferred and marked as inferred.
- **Audience:** The patient. Questions and the summary use plain language.
- **Safety lines (all agents):** No added diagnosis or advice. Every claim is grounded with an evidence quote. Unclear numbers are marked as unclear, never guessed. Red flags get the highest priority.
- **Questions:** Questions the patient wrote are never removed or reworded. At most 3 new AI questions per run. The final ids are assigned by the server.

## Persistence (Supabase)

- Save each structured output, from every attempt, to Storage at `sessions/{session_id}/{agent}/{seq}-{attempt}.json`.
- Save each evaluator result (`pass`, `score`, `issues`) in a table next to the output it judged. This is the record of agent decisions.
- Keep the current question list and understanding state in tables, so that the consultation memory survives between chunks.

## Not in scope

Speech-to-text, the UI, clinician-facing output, and the table schema and Edge Function code (these go in the implementation plan).
