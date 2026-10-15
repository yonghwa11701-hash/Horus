# Horus app UI: design spec

- **Date:** 2026-10-15
- **Owner:** Errolson (app screens and UI)
- **Branch:** `ui/design`
- **Mockups:** `.superpowers/brainstorm/*/content/all-screens-v2.html`

## Intent

The patient should be looking at the doctor, not at the phone. The phone buzzes when a question is worth asking, and one glance (about a second) is enough to read it. Everything else, such as the transcript and the citations, is one tap away but never takes space from the questions.

Answer for the judges' question "doesn't a phone hurt the conversation?": haptic pulse plus a glance, at most 3 large cards, and no manual "Asked" tap because questions clear themselves.

Inspiration: Aside Health (getasidehealth.com) for the overall feel only. We deliberately moved away from their palette and type.

## Visual system: "Clinical Clear"

Light mode only. There is no dark mode. The app ignores the system colour scheme.

| Token | Hex | Use | Contrast |
|---|---|---|---|
| `ink` | `#0B1220` | Body text, headings, End button | 18.7:1 on white |
| `muted` | `#4A5568` | Secondary text, timestamps | 7.0:1 on `surface` |
| `surface` | `#F4F6F8` | "So far" box, notes | n/a |
| `line` | `#D5DBE3` | Card borders | n/a (decorative) |
| `primary` | `#0A58CA` | "Ask next", links, Resume | 6.4:1 with white text, 5.6:1 on `primaryTint` |
| `primaryTint` | `#E8F0FE` | Top card background, citation chips | n/a |
| `chip` | `#E7EBF0` | Dismiss and secondary buttons | ink on chip 12:1 |
| `ok` | `#1E6B3A` | "✓ You asked this", "✓ Saved" | 6.5:1 on white |
| `danger` | `#B42318` | "Delete this appointment" | 6.6:1 on white |
| `rec` | `#E5484D` | Recording dot (not text) | 3.9:1 (≥ 3 for UI) |

`#0B6EFD` was rejected because it is exactly 4.5:1, which is borderline.

- **Type:** the platform system font (no font package). Sizes:
  - Top question: 22pt bold. Other questions: 20pt bold.
  - Body: 16–17pt. Smallest text anywhere: 14pt.
  - Headings: 20–26pt, weight 700–800.
- **Shape:** 8px radius on buttons, 12px on cards.
- **Accessibility, WCAG 2.2 AA:**
  - Every tap target is at least 48×48dp. Use `hitSlop` for text links.
  - Text follows the phone's font-size setting. Don't set `allowFontScaling={false}`.
  - State is never shown by colour alone. Priority uses label + border + size. Recording uses dot + word.
  - Every button has an `accessibilityLabel` that includes the question text.
  - A new top question is announced with `AccessibilityInfo.announceForAccessibility`.
  - Reorder and clear animations are skipped when Reduce Motion is on.

## Screens and routes

Replace the template's tabs with a plain Stack in `src/app/_layout.tsx`.

| # | Route | Screen | Key elements |
|---|---|---|---|
| 1 | `index.tsx` | Home | HORUS wordmark, headline, how-it-works line, big **Start consultation** → consent screen, "doesn't give medical advice" line |
| 1b | `consent.tsx` | Before you start | Shown every time. Three points: not medical advice, your data (saved, deletable), microphone. A doctor-consent checkbox that must be ticked. **Start listening** calls `create-session`; **Back** |
| 2 | `session/[id]/index.tsx` | Live | Status bar (dot + "Listening" + timer, **Pause** button); fixed-height **So far** box; "Ask your doctor" with ≤ 3 question cards; **End consultation** |
| 2b | (state of 2) | Paused | Hollow dot + "Paused", **Resume** in primary, banner "Horus isn't listening. Nothing is being recorded." |
| 3 | `session/[id]/transcript.tsx` (modal) | Transcript | **Live:** same status bar, newest at the bottom, auto-scrolls, **Back to questions**. **Ended** (opened from Summary): read-only with no status bar, scrolls to the cited segment, **Back to summary** |
| 4 | `session/[id]/ending.tsx` | Writing summary | Checklist: transcript saved → summary drafted → checking lines against transcript → listing unanswered questions |
| 5 | `session/[id]/summary.tsx` | Summary | "Your appointment", plus "✓ Saved" shown only after `retain-session` succeeds, "not medical advice" note, 3 sections, citation chips, **Done** (goes to Home), small red "Delete this appointment" link |
| 6 | (sheet on 5) | Source | Cited segment highlighted (tint + left bar + "cited") with one segment before and after; **Close** / **Open in transcript** |

### Live screen details
- **So far box:**
  - Fixed height of 140dp. It never grows.
  - Scrolls inside itself, newest line first, 16pt.
  - The header has a "Full transcript ›" link, which opens screen 3.
- **Question cards:**
  - The cards area is a vertical ScrollView, so at large font scales every question and Dismiss stays reachable. So far stays fixed above it.
  - At most 3, in the order the backend ranks them. The top card is "● Ask next": primary border, tint background, 22pt.
  - Every card has exactly one button, **Dismiss**. There is no Asked button and no Flag.
- **Auto-clear:** when the backend marks a suggestion `answered`:
  - The card collapses to a dashed outline with "✓ You asked this" and the question crossed out.
  - After about 3 seconds it is removed.
- **Moved up:** when a card is promoted to the top, it shows a "↑ Moved up" badge for about 3 seconds and slides into place. Cards never jump while the patient is reading.
- **Haptic:** when a new `high` priority suggestion arrives, fire `expo-haptics` `notificationAsync(Success)` once.
- **While paused:** cards still update quietly. There is no haptic and no announcement. On Resume, refetch the active suggestions.

### Summary screen details
- Sections map one-to-one to `SummaryLine.kind`:
  - `summary` → "What was said"
  - `next_step` → "Next steps the doctor gave" (numbered)
  - `outstanding` → "Still unanswered"
- **Citation chips:**
  - Numbered [1], [2] in reading order, one number per unique `segment_id`.
  - The chip is underlined so it doesn't rely on colour. Tapping it opens the source sheet.
- **Delete this appointment:** asks to confirm, then calls `retain-session { keep: false }` and goes to Home. If the patient never taps it, the session is kept: `retain-session { keep: true }` is called when the summary loads. This is a deliberate reading of §2.4: the patient still chooses, and keeping is the default.

## Data each screen needs

All calls go through `lib/api.ts`. `USE_MOCKS` in `lib/config.ts` serves fixtures shaped like `types/api.ts`.

| Screen | Source |
|---|---|
| Home | `create-session` → navigate to `session/[id]` |
| Live, status | `useTranscription({ sessionId })`: `status`, `start/pause/stop`, `error` (Kendrick) |
| Live, questions | Initial fetch, then Realtime on `suggestions` filtered by `session_id` only. Filter `active` and sort by priority in the app, so the `answered` update still arrives |
| Live, So far | Realtime on `agent_events` where `agent = understanding` and `type = output`; reads `payload.said` (see open items) |
| Transcript | Realtime on `transcript_segments` by `session_id`, ordered by `seq` |
| Ending | `finalize-session` returns `summary_id`, then fetch it directly. `summary.ready` is only a backup |
| Summary and source | `summaries.lines` plus `transcript_segments` for the cited ids, with one neighbour each side by `seq` in the same `session_id` (not by id ±1) |

## Error and empty states

- **Realtime disconnect:** show a small banner, "Reconnecting…". On reconnect, refetch suggestions and segments.
- **Microphone:**
  - `connecting`: show "Starting…" and no "Listening" yet.
  - Permission blocked: "Horus needs the microphone", with an **Open Settings** button.
  - Show "Paused" only after `pause()` resolves.
- **Pending actions:** Start, Dismiss and Delete disable themselves while their request is pending. On failure, show an inline "Didn't work, try again" and keep the current state.
- **Empty summary:** if there are no lines, say "Nothing to summarise". An empty section is hidden. Transcript access stays.
- **Back navigation:**
  - On Live, Android back and swipe-back ask "End consultation?", using `usePreventRemove` (covers both platforms).
  - Leaving Summary uses `router.dismissAll()` then `replace('/')`, so the session routes are cleared.
- **Source sheet:** use RN `Modal` so screen-reader focus is trapped in the sheet and returns to the citation chip on close.
- **No questions yet:** show "Listening… questions will appear here" in muted 17pt in the cards area.
- **`useTranscription` error:** show a banner under the status bar, "Not hearing anything. Check the microphone.", with a **Retry** button. Questions already on screen stay.
- **`finalize-session` takes more than 60s or fails:** the ending screen shows "This is taking longer than usual" with a **Try again** button. The transcript is already saved.

## Changes needed from other owners

These are not decided by this spec. Raise each one with its owner.

1. **Resolution agent P1 → P0** (Angelika, Theo). There is no Asked button any more, so auto-clearing is the only way a question leaves the screen apart from Dismiss.
2. **Ageing rule in Prioritisation** (Angelika). Proposal: an unasked question drops one priority level after about 3 minutes, and a newer high question takes the top slot.
3. **`payload.said` on Understanding events** (Angelika, Theo). This is a short plain-English line for the So far box.
4. **`update-suggestion` statuses.** The app sends only `dismissed`. `asked` and `flagged` are unused: SummaryLine has no suggestion id, so Flag was dropped.
5. **Light-only:** set `userInterfaceStyle: "light"` in `app.json` (Kendrick owns app.json).
6. **Path convention.** `CLAUDE.md` says `app/` and `components/`, but the repo uses `src/app/` and `src/components/`. Update `CLAUDE.md`.

## Build order

1. **P0 first:** Home, Live (cards, Dismiss, haptic, pause), Ending, Summary with citations, Delete.
2. **Then, if P0 works by around 14:30:** So far box (needs `payload.said`), live transcript modal (P1), "Moved up" animation.

## Out of scope

- Dark mode.
- History of past appointments.
- Settings and accounts.
- Speaker labels in the transcript, unless Scribe provides diarisation.
- Custom fonts.
- Lovable and Claude Design. Screens are built directly in Expo.

## Testing

- `npx tsc --noEmit` and `npx expo lint` pass.
- Walk the full flow in mock mode with fixtures for every state: empty, 3 questions, auto-clear, moved-up, paused, error, summary with citations.
- Spot-check on a physical Android phone:
  - Largest font scale with TalkBack on.
  - Reduce Motion (on Android, "Remove animations") on.
  - The haptic is felt with the phone face up on a desk.
