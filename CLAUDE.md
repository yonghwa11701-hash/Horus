# CLAUDE.md — Project context for all agents

Read this file in full before making changes. It is the source of truth for scope, contracts and ownership.
If code and this file disagree, ask the human before "fixing" either.

## 1. What this is

**Product:** An AI patient advocate that sits with a patient during a medical appointment, listens, and helps
them ask the right questions in the moment. When the appointment ends, it produces a checked summary of what
was said, the agreed next steps, and any questions still unanswered.

**One-liner:** "Our app is a team of AI agents that sits with patients in their appointments, prompting the
questions they'd forget to ask, then turning the visit into a verified summary."

**Context:** Built by team Horus at the Accel AI Innovate London hackathon (Thu 15 Oct 2026).
Brief: "Build a product where Claude agents run for longer and/or work as a team."
Judging criteria: real output · agent design (planning, hand-offs, error recovery) · business viability · demo.
**Hard deadline: submission at 5:00 PM GMT+1. Feature freeze at 4:00 PM GMT+1.**

This is a **functional prototype**, not a clinically deployable application.

## 2. Safety rules (non-negotiable)

1. Our app **never** gives medical advice, diagnoses, or treatment/medication recommendations.
   Outputs are only (a) questions for the patient to ask, (b) summaries of what was said, or (c) next steps the clinician stated.
2. **No real patient data.** Synthetic consultation scripts and audio only. Speakers in any live demo give explicit consent.
   Do not save real patient audio by default.
3. **No secrets in the app.** The Expo app only ever holds the Supabase **anon** key.
   Never put the Supabase service-role key, `ANTHROPIC_API_KEY` or `ELEVENLABS_API_KEY` in Expo code, `app.json` or `.env` files bundled into the app.
   ElevenLabs access from the phone uses a short-lived single-use token issued by an Edge Function.
4. The patient is always in control: they can dismiss any suggestion, and they choose at the end whether to save or discard the session.
5. Store structured AI outputs only. Do not attempt to capture hidden model reasoning.

## 3. MVP scope

| Feature | Priority | Notes |
|---|---|---|
| Live transcription | P0 | ElevenLabs `scribe_v2_realtime`; fallback = chunked upload (§5.2) |
| Question generation | P0 | Core value |
| Evaluation (LLM output review) | P0 | Every question is approved or rejected before the patient sees it |
| Human intervention | P0 | Patient taps Asked / Dismiss / Flag on each question |
| Live UI + haptics | P0 | New approved high-priority question → haptic pulse (`expo-haptics`) |
| Prioritisation + deduplication | P0 | At most 3 active questions, highest priority first |
| Summary generation | P0 | End of session: summary, next steps, outstanding questions |
| Basic audit log | P0 | Every agent step writes an `agent_events` row. **The judges see this.** |
| Save / discard | P0 | Patient chooses at session end |
| Automatic question resolution | P1 | Only once live suggestions are stable |
| Live transcript display | P1 | Required inside the summary screen; optional in the live view |
| Agent outputs as JSON files in Storage | P1 | For the demo, store outputs in `agent_events.payload` |
| Anonymous Supabase Auth | P1 | Use if quick; otherwise one hard-coded demo user |
| Account creation, login | Out | Do not build |
| Medical history | Out | Do not build |
| History of previous appointments | Out | Do not build |
| Settings | Out | Do not build |
| Lovable | Out | Not used; screens are built directly in Expo |

**If you are about to build something not marked P0, stop and ask.**

## 4. User journey (MVP)

1. **Open app** → no account (anonymous or demo user).
2. **Home** → "Start consultation" button.
3. **Consultation (live)** → recording indicator, pause button, up to 3 active question cards
   (Asked / Dismiss / Flag), haptic pulse on new important questions, optional live transcript. "End" button.
4. **Agents run throughout the consultation**, one short Edge Function call per finalised transcript segment:
   Understanding → Question Generation → Evaluation → Prioritisation/dedup → (Resolution, P1).
5. **End** → `finalize-session` → Summary screen: summary lines, agreed next steps, outstanding questions.
   Tapping a line shows the transcript segment it came from.
6. **Save or discard** → the patient chooses whether to keep the transcript and summary.

## 5. Architecture

```
Expo app ──(1) create-session──────────────▶ Edge Function
         ──(2) get-scribe-token────────────▶ Edge Function ──▶ ElevenLabs (single-use token, 15 min)
         ──(3) audio stream (PCM16, 16 kHz)─▶ ElevenLabs scribe_v2_realtime
         ◀──── finalised transcript segments ─┘
         ──(4) insert transcript_segments ──▶ Supabase Postgres
                                                  │
                         process-segment (Edge Function, one short call per segment)
                           Understanding → Question Gen → Evaluation → Prioritise/dedup → (Resolution)
                           writes: suggestions, agent_events
                                                  │
Expo app ◀──── Supabase Realtime (suggestions, summaries) ◀──┘
Web agent timeline (laptop) ◀──── Supabase Realtime (agent_events)
         ──(5) finalize-session ────────────▶ Edge Function → Summary agent → Evaluation → summaries
```

- Each Claude call happens inside a **short-lived** Edge Function request, never one function running for the whole appointment (hosted Edge Functions have execution time limits).
- `process-segment` is triggered either by the app after inserting a segment, or by a database webhook on `transcript_segments` insert. **Angelika decides; record the decision here.**

### 5.1 Critical dependency: real-time mic streaming in React Native
ElevenLabs' client SDKs target the browser and React; React Native is not documented. Streaming raw PCM16 from
the phone mic likely needs a native module and a development build (not Expo Go).
**Kendrick has until 11:45 to make this work on a physical Android phone.** If it doesn't, switch to §5.2 and do not return to it.

### 5.2 Fallback: chunked upload
`expo-audio` records ~15 s chunks → upload each to Storage → `transcribe-chunk` Edge Function calls
ElevenLabs batch speech-to-text (OpenAI as backup) → inserts `transcript_segments` → same pipeline from there.
Final demo fallback: a pre-recorded synthetic audio file, or a pre-made transcript fixture.

## 6. Agents (inside Edge Functions)

| Agent | Input | Output | Model (suggested) |
|---|---|---|---|
| Understanding | new segment + recent segments | what was said; anything left unexplained (jargon, unclear next step, missing reason) | claude-haiku-5-5 |
| Question Generation | Understanding output + active suggestions | candidate questions, each with `source_segment_ids` | claude-haiku-5-5 |
| Evaluation | candidate + rubric | approve / reject with reason; rejected → regenerate once → else `rejected` | claude-sonnet-5-5 |
| Prioritisation / dedup | approved candidates + active suggestions | priority; merge duplicates; at most 3 `active` | claude-haiku-5-5 or code |
| Resolution (P1) | new segment + active suggestions | marks suggestions `answered` | claude-haiku-5-5 |
| Summary | full transcript + suggestions | summary, next steps, outstanding questions; every line cites segment ids | claude-sonnet-5-5 |

**Evaluation rubric** (Theo owns; prompt files in `supabase/functions/_shared/prompts/`):
questions only · no diagnosis, treatment or medication advice · supported by a cited transcript segment ·
relevant to this consultation · plain English · at most 25 words.

Every agent step writes one `agent_events` row (including rejections and retries). That log is the demo's evidence of hand-offs and error recovery.

## 7. Integration contract (frozen — change only with team agreement)

| Function / event | Kind | Owner | Used by |
|---|---|---|---|
| `create-session` | Edge Function → `{ session_id }` | Angelika | App |
| `get-scribe-token` | Edge Function → `{ token }` | Kendrick | App |
| `transcript.final` | insert into `transcript_segments` | Kendrick (app side) | Pipeline |
| `process-segment` | Edge Function `{ session_id, segment_id }` | Angelika | Pipeline |
| `suggestion.created` / `suggestion.updated` | Realtime on `suggestions` | Angelika | App |
| `update-suggestion` | `{ suggestion_id, status: "asked"│"dismissed"│"flagged" }` | Angelika | App |
| `finalize-session` | Edge Function → `{ summary_id }` | Angelika | App |
| `summary.ready` | Realtime on `summaries` | Angelika | App |
| `retain-session` | Edge Function `{ session_id, keep: boolean }` | Angelika | App |

### Suggestion shape (the app builds against this using mocks)
```json
{
  "id": "q001",
  "session_id": "abc123",
  "question": "What are the possible side effects?",
  "priority": "high",
  "status": "active",
  "source_segment_ids": [4],
  "evaluation": { "relevant": true, "supported": true, "advice_free": true }
}
```

## 8. Data model (Supabase)

```ts
type Session = { id: string; user_id: string; started_at: string; ended_at?: string;
  status: "live" | "paused" | "ended" | "saved" | "discarded" };
type TranscriptSegment = { id: number; session_id: string; seq: number; text: string; start_ms?: number; end_ms?: number; created_at: string };
type Suggestion = {
  id: string; session_id: string; question: string;
  priority: "high" | "medium" | "low";
  status: "active" | "asked" | "answered" | "dismissed" | "flagged" | "rejected";
  source_segment_ids: number[];
  evaluation: { relevant: boolean; supported: boolean; advice_free: boolean; reason?: string };
  created_at: string;
};
type SummaryLine = { text: string; segment_ids: number[]; kind: "summary" | "next_step" | "outstanding" };
type Summary = { id: string; session_id: string; lines: SummaryLine[]; created_at: string };
type AgentEvent = {
  id: number; session_id: string;
  agent: "transcriber" | "understanding" | "question_generation" | "evaluation" | "prioritisation" | "resolution" | "summary";
  type: "started" | "output" | "approved" | "rejected" | "retry" | "error";
  payload: unknown;          // the structured agent output, stored here for the demo
  cost_usd?: number; created_at: string;
};
// P1 only: session_artifacts(id, session_id, path, kind, created_at) + private bucket "patient-artifacts"
```
Shared TS types live in `types/api.ts` in the app. Do not redefine them elsewhere.
Enable RLS on all tables. The app uses the anon key only.

## 9. Ownership — do not edit files you don't own without asking

| Person | Owns |
|---|---|
| Errolson | App screens and UI (`app/`, `components/`), Realtime subscriptions in the app, haptics, web agent timeline |
| Kendrick | Mic streaming / `hooks/useTranscription.ts`, `get-scribe-token`, Android build config (`android/`, `app.json` permissions/plugins), standalone APK |
| Angelika | Supabase schema + RLS (**first, by 11:15 — it is the contract**), all other Edge Functions, agent pipeline |
| Theo | Prompts and evaluation rubric (`supabase/functions/_shared/prompts/`), test scenarios and fixtures |
| Yong | Synthetic consultation scripts and audio, copy text, pitch |

### `useTranscription()` interface (Kendrick implements; screens only call it)
```ts
function useTranscription(opts: { sessionId: string }): {
  start: () => Promise<void>;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
  status: "idle" | "connecting" | "live" | "paused" | "error";
  mode: "realtime" | "chunked";      // which path is active (§5.1 / §5.2)
  lastSegmentSeq: number;
  error: string | null;
};
```

## 10. Conventions for agents working in this repo

- TypeScript everywhere. Small, plain components. No new UI libraries without asking.
- **Mock mode:** a `USE_MOCKS` flag in `lib/config.ts` switches the data layer to local fixtures matching §7–§8,
  so the UI can be built before the pipeline exists. All backend calls go through `lib/api.ts`.
- Pin the Expo SDK version. Never run upgrade commands.
- Try existing Expo libraries before any custom native module. Do not write Kotlin or Swift without asking Kendrick.
- Do not build anything marked Out in §3.
- Prefer working and simple over complete. If a P0 is at risk, cut polish, not the agent pipeline.
- After any change, the app must still start with `npx expo start`.

## 11. Definition of done (team acceptance checklist)

- [ ] App starts a consultation on a real phone
- [ ] Microphone captures and transcribes speech (realtime or chunked)
- [ ] Final transcript segments reach Supabase
- [ ] Claude generates questions from the transcript
- [ ] Evaluation agent approves or rejects questions, and rejections are visible in `agent_events`
- [ ] Approved questions appear on the phone with haptics
- [ ] Agent outputs are saved (`agent_events.payload`)
- [ ] Ending the session produces a readable summary with citations
- [ ] User can save or discard the session
- [ ] The full demo works without manual database edits