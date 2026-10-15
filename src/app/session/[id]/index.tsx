import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Banner, Btn, confirm } from '@/components/ui';
import { C } from '@/constants/theme';
import { useConsultationVoice } from '@/hooks/use-consultation-voice';
import { loadConsultation, subscribeToConsultation } from '@/lib/consultations';
import type { Suggestion, TranscriptSegment } from '@/types/consultation';

const RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;
const MAX_CARDS = 3; // CLAUDE.md §3
const SHOW_ANSWERED_MS = 3000;
const MOVED_UP_MS = 3000;

type Rows = Map<string, Suggestion>;

const isUrgent = (q: Suggestion) => q.priority === 'critical' || q.priority === 'high';

/** Highest priority first, newest first within a priority. */
function rankActive(rows: Rows, dismissed: Set<string>) {
  return [...rows.values()]
    .filter((q) => q.status === 'approved' && !dismissed.has(q.question_id))
    .sort((a, b) => RANK[a.priority] - RANK[b.priority] || b.created_at.localeCompare(a.created_at))
    .slice(0, MAX_CARDS);
}

/** Snapshot and Realtime rows can arrive out of order; keep the newest version of each. */
function merge(rows: Rows, incoming: Suggestion[]): Rows {
  const next = new Map(rows);
  for (const q of incoming) {
    const have = next.get(q.question_id);
    if (!have || have.updated_at <= q.updated_at) next.set(q.question_id, q);
  }
  return next;
}

export default function Live() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [error, setError] = useState<string | null>(null);
  const voice = useConsultationVoice({ sessionId: id, onError: (e) => setError(e.message) });
  const [rows, setRows] = useState<Rows>(new Map());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [answered, setAnswered] = useState<Suggestion[]>([]);
  const [movedUp, setMovedUp] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [ending, setEnding] = useState(false);
  const [segments, setSegments] = useState<Map<string, TranscriptSegment>>(new Map());
  const [showTranscript, setShowTranscript] = useState(false);
  const rowsRef = useRef<Rows>(rows);
  const dismissedRef = useRef(dismissed);
  const pausedRef = useRef(paused);
  useEffect(() => {
    dismissedRef.current = dismissed;
    pausedRef.current = paused;
  }, [dismissed, paused]);

  const busy = voice.phase === 'starting' || voice.phase === 'stopping';
  const live = voice.phase === 'recording';

  function listen() {
    setError(null);
    voice.start().then(() => setPaused(false), () => {});
  }

  useEffect(() => {
    voice.start().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, [live]);

  useEffect(() => {
    function apply(incoming: Suggestion[]) {
      const before = rankActive(rowsRef.current, dismissedRef.current);
      const next = merge(rowsRef.current, incoming);
      const after = rankActive(next, dismissedRef.current);
      const beforeIds = new Set(before.map((q) => q.question_id));

      const justAnswered = incoming.filter((q) => q.status === 'resolved' && beforeIds.has(q.question_id));
      if (justAnswered.length) {
        setAnswered((a) => [...a, ...justAnswered]);
        setTimeout(() => setAnswered((a) => a.filter((q) => !justAnswered.includes(q))), SHOW_ANSWERED_MS);
      }

      const top = after[0];
      if (top && top.question_id !== before[0]?.question_id) {
        if (beforeIds.has(top.question_id)) {
          setMovedUp(top.question_id);
          setTimeout(() => setMovedUp((m) => (m === top.question_id ? null : m)), MOVED_UP_MS);
        }
        // Paused: cards still update, but no buzz and no announcement (spec).
        if (!pausedRef.current) AccessibilityInfo.announceForAccessibility(`New top question: ${top.question}`);
      }
      const newUrgent = after.some((q) => isUrgent(q) && !before.some((b) => b.question_id === q.question_id && isUrgent(b)));
      if (newUrgent && !pausedRef.current) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      rowsRef.current = next;
      setRows(next);
    }

    const addSegments = (rows: TranscriptSegment[]) =>
      setSegments((m) => {
        const next = new Map(m);
        rows.forEach((seg) => next.set(seg.id, seg));
        return next;
      });

    let unsubscribe: (() => void) | undefined;
    let alive = true;
    subscribeToConsultation(id, {
      onSuggestion: (q) => apply([q]),
      onTranscript: (seg) => addSegments([seg]),
      // Reload on every (re)subscribe so rows missed while disconnected are not lost.
      onStatus: (status) => {
        if (status === 'SUBSCRIBED') loadConsultation(id).then(({ suggestions, segments }) => {
            if (!alive) return;
            apply(suggestions);
            addSegments(segments);
          }, () => {});
      },
    }).then(
      (u) => (alive ? (unsubscribe = u) : u()),
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [id]);

  async function pause() {
    try {
      await voice.pause();
      setPaused(true);
    } catch {}
  }

  async function end() {
    setEnding(true);
    try {
      await voice.end();
      router.replace(`/session/${id}/ending`);
    } catch {
      setEnding(false);
    }
  }

  // Android back / swipe-back must not silently end the recording.
  usePreventRemove(!ending, () => confirm('End consultation?', 'Horus will stop listening and write your summary.', 'End', end));

  const active = rankActive(rows, dismissed);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  const statusLabel =
    voice.phase === 'starting' ? 'Starting…'
    : voice.phase === 'stopping' ? 'Stopping…'
    : live ? 'Listening'
    : paused ? 'Paused'
    : 'Not listening';

  return (
    <SafeAreaView style={s.root}>
      <View style={s.bar}>
        <View style={s.rec} accessible accessibilityLabel={`${statusLabel}, ${mm} minutes ${ss} seconds`}>
          <View style={[s.dot, !live && s.dotOff]} />
          <Text style={s.recText}>{statusLabel}</Text>
          <Text style={s.time}>
            {mm}:{ss}
          </Text>
        </View>
        <Btn
          label={live ? '❚❚ Pause' : '▶ Resume'}
          accessibilityLabel={live ? 'Pause listening' : 'Resume listening'}
          variant={live ? 'outline' : 'primary'}
          disabled={busy || ending || (!live && !paused)}
          onPress={live ? pause : listen}
          style={{ minHeight: 48, paddingHorizontal: 14 }}
        />
      </View>

      {paused && !live && <Banner text="Horus isn’t listening. Nothing is being recorded." />}
      {voice.unconfirmedAudio && (
        <Banner
          text="The last few seconds of audio may not have been captured."
          action={{ label: 'Continue anyway', onPress: voice.acknowledgeUnconfirmedAudio }}
        />
      )}
      {error && !voice.unconfirmedAudio && voice.phase === 'error' && (
        <Banner text={`Not listening: ${error}`} action={{ label: 'Try again', onPress: listen }} />
      )}

      <ScrollView contentContainerStyle={s.qs}>
        <View style={s.headRow}>
          <Text style={s.h2} accessibilityRole="header">
            Ask your doctor
          </Text>
          <Pressable accessibilityRole="button" onPress={() => setShowTranscript(true)} hitSlop={12} style={s.tsLink}>
            <Text style={s.link}>Transcript ›</Text>
          </Pressable>
        </View>
        {active.length === 0 && answered.length === 0 && <Text style={s.empty}>{live ? 'Listening… questions' : 'Questions'} will appear here.</Text>}
        {active.map((q, i) => (
          <Animated.View key={q.question_id} layout={LinearTransition} entering={FadeIn} exiting={FadeOut} style={[s.q, i === 0 && s.qTop]}>
            <View style={s.tagRow}>
              <Text style={[s.tag, i > 0 && { color: C.muted }]}>{i === 0 ? '● Ask next' : 'Also worth asking'}</Text>
              {movedUp === q.question_id && <Text style={s.moved}>↑ Moved up</Text>}
            </View>
            <Text style={[s.qt, i === 0 && s.qtTop]}>{q.question}</Text>
            <View style={s.acts}>
              {/* ponytail: local-only; suggestions are read-only to the app until an update-suggestion function exists */}
              <Btn
                label="Dismiss"
                accessibilityLabel={`Dismiss: ${q.question}`}
                onPress={() => setDismissed((d) => new Set(d).add(q.question_id))}
                style={{ minHeight: 48 }}
              />
            </View>
          </Animated.View>
        ))}
        {answered.map((q) => (
          <Animated.View key={`done-${q.question_id}`} layout={LinearTransition} entering={FadeIn} exiting={FadeOut} style={[s.q, s.qDone]}>
            <Text style={[s.tag, { color: C.ok }]}>✓ You asked this</Text>
            <Text style={s.qtDone}>{q.question}</Text>
          </Animated.View>
        ))}
      </ScrollView>

      <View style={s.foot}>
        <Btn label={ending ? 'Ending…' : 'End consultation'} variant="ink" onPress={end} disabled={ending || busy} />
      </View>

      <LiveTranscript
        visible={showTranscript}
        segments={[...segments.values()].sort((a, b) => a.sequence - b.sequence)}
        partial={voice.partialTranscript}
        status={statusLabel}
        onClose={() => setShowTranscript(false)}
      />
    </SafeAreaView>
  );
}

const clock = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

function LiveTranscript({ visible, segments, partial, status, onClose }: {
  visible: boolean; segments: TranscriptSegment[]; partial: string; status: string; onClose: () => void;
}) {
  const scroll = useRef<ScrollView>(null);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.root}>
        <View style={s.tsHead}>
          <Text style={s.tsTitle} accessibilityRole="header">
            Transcript
          </Text>
          <Text style={s.time}>{status} · newest at the bottom</Text>
        </View>
        <ScrollView ref={scroll} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })} contentContainerStyle={s.tsBody}>
          {segments.length === 0 && !partial && <Text style={s.empty}>Nothing heard yet.</Text>}
          {segments.map((seg) => (
            <View key={seg.id}>
              <Text style={s.segTime}>{clock(seg.start_ms)}</Text>
              <Text style={s.segText}>{seg.text}</Text>
            </View>
          ))}
          {!!partial && (
            <Text style={s.partial} accessibilityLiveRegion="polite">
              {partial}…
            </Text>
          )}
        </ScrollView>
        <View style={s.foot}>
          <Btn label="Back to questions" onPress={onClose} />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  rec: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: C.rec },
  dotOff: { backgroundColor: 'transparent', borderWidth: 3, borderColor: C.muted },
  recText: { fontSize: 16, fontWeight: '600', color: C.ink },
  time: { fontSize: 16, fontWeight: '500', color: C.muted, fontVariant: ['tabular-nums'] },
  qs: { paddingHorizontal: 16, paddingBottom: 16, gap: 12 },
  h2: { fontSize: 20, fontWeight: '700', color: C.ink },
  headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tsLink: { minHeight: 48, justifyContent: 'center' },
  link: { fontSize: 16, fontWeight: '700', color: C.primary, textDecorationLine: 'underline' },
  tsHead: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, gap: 2 },
  tsTitle: { fontSize: 24, fontWeight: '800', color: C.ink },
  tsBody: { paddingHorizontal: 16, paddingBottom: 16, gap: 14 },
  segTime: { fontSize: 14, fontWeight: '700', color: C.muted },
  segText: { fontSize: 17, lineHeight: 25, color: C.ink },
  partial: { fontSize: 17, lineHeight: 25, color: C.muted, fontStyle: 'italic' },
  empty: { fontSize: 17, color: C.muted, lineHeight: 24 },
  q: { borderWidth: 2, borderColor: C.line, borderRadius: 12, padding: 14 },
  qTop: { borderWidth: 3, borderColor: C.primary, backgroundColor: C.primaryTint },
  qDone: { borderStyle: 'dashed', paddingVertical: 10 },
  tagRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  tag: { fontSize: 14, fontWeight: '700', color: C.primary },
  moved: { fontSize: 13, fontWeight: '700', color: C.ink, backgroundColor: '#fff', borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  qt: { fontSize: 20, fontWeight: '700', lineHeight: 26, color: C.ink, marginBottom: 12 },
  qtTop: { fontSize: 22, lineHeight: 29 },
  qtDone: { fontSize: 16, color: C.muted, textDecorationLine: 'line-through' },
  acts: { flexDirection: 'row', justifyContent: 'flex-end' },
  foot: { padding: 16 },
});
