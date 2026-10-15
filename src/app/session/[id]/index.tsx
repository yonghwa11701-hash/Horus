import * as Haptics from 'expo-haptics';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, Vibration, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Banner, Btn, confirm } from '@/components/ui';
import { C } from '@/constants/theme';
import { useConsultationVoice } from '@/hooks/use-consultation-voice';
import { loadConsultation, subscribeToConsultation } from '@/lib/consultations';
import { isConsultationId } from '@/lib/consultation-state';
import { voiceDebug } from '@/lib/voice/debug';
import type { Suggestion, TranscriptSegment } from '@/types/consultation';

const RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;
const MAX_CARDS = 3; // CLAUDE.md §3
const MOVED_UP_MS = 3000;

type Rows = Map<string, Suggestion>;

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

export default function LiveRoute() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  if (!isConsultationId(id)) return <Redirect href="/" />;
  return <Live key={id} id={id} />;
}

function Live({ id }: { id: string }) {
  const [error, setError] = useState<string | null>(null);
  const [segments, setSegments] = useState<Map<string, TranscriptSegment>>(new Map());
  const addSegments = useCallback((incoming: TranscriptSegment[]) => {
    setSegments((current) => {
      const next = new Map(current);
      incoming.forEach((segment) => next.set(segment.id, segment));
      return next;
    });
  }, []);
  const voice = useConsultationVoice({
    sessionId: id, onError: (e) => setError(e.message),
    // A durable save acknowledgement updates the UI even if Realtime is delayed.
    onSegment: (segment) => addSegments([segment]),
  });
  const [rows, setRows] = useState<Rows>(new Map());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [movedUp, setMovedUp] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [ending, setEnding] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const rowsRef = useRef<Rows>(rows);
  const seenQuestions = useRef(new Set<string>());
  const dismissedRef = useRef(dismissed);
  const pausedRef = useRef(paused);
  useEffect(() => {
    dismissedRef.current = dismissed;
    pausedRef.current = paused;
  }, [dismissed, paused]);

  const busy = voice.phase === 'starting' || voice.phase === 'stopping';
  const live = voice.phase === 'recording';
  // Web never auto-starts (mic needs a tap), so until the first start the patient must be told plainly.
  const notStarted = Platform.OS === 'web' && voice.phase === 'idle' && !paused && !ending;

  function listen() {
    setError(null);
    voice.start().then(() => setPaused(false), (e) => setError(e instanceof Error ? e.message : 'Could not start listening.'));
  }

  useEffect(() => {
    // Browsers require a direct microphone tap; mounting after the consent/API
    // navigation is no longer a user gesture. Native keeps the automatic start.
    if (Platform.OS !== 'web') voice.start().catch(() => {});
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

      const top = after[0];
      if (top && top.question_id !== before[0]?.question_id) {
        if (beforeIds.has(top.question_id)) {
          setMovedUp(top.question_id);
          setTimeout(() => setMovedUp((m) => (m === top.question_id ? null : m)), MOVED_UP_MS);
        }
        // Paused: cards still update, but no buzz and no announcement (spec).
        if (!pausedRef.current) AccessibilityInfo.announceForAccessibility(`New top question: ${top.question}`);
      }
      rowsRef.current = next;
      setRows(next);
    }

    let unsubscribe: (() => void) | undefined;
    let alive = true;
    subscribeToConsultation(id, {
      onSuggestion: (q) => { if (alive) apply([q]); },
      onTranscript: (seg) => { if (alive) addSegments([seg]); },
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
  }, [id, addSegments]);

  async function pause() {
    try {
      await voice.pause();
      setPaused(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not pause listening.'); }
  }

  async function end() {
    setError(null);
    setEnding(true);
    try {
      await voice.end();
      router.replace(`/session/${id}/ending`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not finish saving. Retry End consultation.');
      setEnding(false);
    }
  }

  // Android back / swipe-back must not silently end the recording.
  usePreventRemove(!ending, () => confirm('End consultation?', 'Horus will stop listening and write your summary.', 'End', end));

  function hideQuestion(questionId: string) {
    const next = new Set(dismissedRef.current).add(questionId);
    dismissedRef.current = next;
    setDismissed(next);
  }

  const active = useMemo(() => rankActive(rows, dismissed), [rows, dismissed]);
  useEffect(() => {
    const appeared = active.some((q) => !seenQuestions.current.has(q.question_id));
    active.forEach((q) => seenQuestions.current.add(q.question_id));
    if (!appeared) return;
    const method = Platform.OS === 'android' ? 'vibration' : 'notification';
    if (paused || ending) {
      voiceDebug('haptic', { haptic_method: method, outcome: 'skipped', haptic_skip_reason: paused ? 'paused' : 'ending' });
      return;
    }
    // Every newly visible question, not only urgent ones. Replays/reordering must not buzz again.
    voiceDebug('haptic', { haptic_method: method, outcome: 'requested' });
    if (Platform.OS === 'android') {
      try {
        // An alert vibration, not View touch feedback (which can silently do nothing).
        // expo-haptics already supplies the normal Android VIBRATE permission.
        Vibration.vibrate([0, 160, 80, 160], false);
        voiceDebug('haptic', { haptic_method: method, outcome: 'queued' });
      } catch {
        voiceDebug('haptic', { haptic_method: method, outcome: 'failure' });
      }
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).then(
      () => voiceDebug('haptic', { haptic_method: method, outcome: 'success' }),
      () => voiceDebug('haptic', { haptic_method: method, outcome: 'failure' }),
    );
  }, [active, paused, ending]);
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
        {!notStarted && <Btn
          label={live ? '❚❚ Pause' : paused ? '▶ Resume' : '▶ Start'}
          accessibilityLabel={live ? 'Pause listening' : paused ? 'Resume listening' : 'Start microphone'}
          variant={live ? 'outline' : 'primary'}
          disabled={busy || ending || voice.unconfirmedAudio}
          onPress={live ? pause : listen}
          style={{ minHeight: 48, paddingHorizontal: 14 }}
        />}
      </View>

      {paused && !live && <Banner text="Horus isn’t listening. Nothing is being recorded." />}
      {voice.inputWarning && <Banner text={voice.inputWarning} />}
      {voice.unconfirmedAudio && (
        <Banner
          text="The last few seconds of audio may not have been captured."
          action={{ label: 'Continue anyway', onPress: voice.acknowledgeUnconfirmedAudio }}
        />
      )}
      {error && !voice.unconfirmedAudio && (
        <Banner text={error} action={voice.phase === 'error' ? { label: 'Try again', onPress: listen } : undefined} />
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
        {notStarted && (
          <View style={s.startCard}>
            <Text style={s.startTitle}>Horus isn’t listening yet</Text>
            <Text style={s.startText}>Tap below when your appointment begins.</Text>
            <Btn label="● Start listening" variant="primary" onPress={listen} style={{ minHeight: 64 }} />
          </View>
        )}
        {!notStarted && active.length === 0 && <Text style={s.empty}>{live ? 'Listening… questions will appear here.' : busy ? 'Connecting microphone…' : 'Start listening to see suggested questions.'}</Text>}
        {active.map((q, i) => (
          <Animated.View key={q.question_id} layout={LinearTransition} entering={FadeIn} exiting={FadeOut} style={[s.q, i === 0 && s.qTop]}>
            <View style={s.tagRow}>
              <Text style={[s.tag, i > 0 && { color: C.muted }]}>{i === 0 ? '● Ask next' : 'Also worth asking'}</Text>
              {movedUp === q.question_id && <Text style={s.moved}>↑ Moved up</Text>}
            </View>
            <Text style={[s.qt, i === 0 && s.qtTop]}>{q.question}</Text>
            <View style={s.acts}>
              <Btn
                label="Dismiss"
                accessibilityLabel={`Dismiss: ${q.question}`}
                onPress={() => hideQuestion(q.question_id)}
                style={{ minHeight: 48 }}
              />
            </View>
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
        pendingCount={voice.pendingCount}
        status={statusLabel}
        onClose={() => setShowTranscript(false)}
      />
    </SafeAreaView>
  );
}

const clock = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

function LiveTranscript({ visible, segments, partial, pendingCount, status, onClose }: {
  visible: boolean; segments: TranscriptSegment[]; partial: string; pendingCount: number; status: string; onClose: () => void;
}) {
  const scroll = useRef<ScrollView>(null);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.root}>
        <View style={s.tsHead}>
          <Text style={s.tsTitle} accessibilityRole="header">
            Transcript
          </Text>
          <Text style={s.time}>{status} · {segments.length} saved · newest at the bottom</Text>
        </View>
        <ScrollView ref={scroll} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })} contentContainerStyle={s.tsBody}>
          {segments.length === 0 && !partial && !pendingCount && <Text style={s.empty}>Nothing heard yet.</Text>}
          {pendingCount > 0 && <Text style={s.empty}>Saving transcript…</Text>}
          {segments.map((seg) => (
            <View key={seg.id}>
              <Text style={s.segTime}>{clock(seg.start_ms)}</Text>
              <Text style={s.segText}>{seg.text}</Text>
            </View>
          ))}
          {!!partial && (
            <View>
              <Text style={s.segTime}>Live · not saved yet</Text>
              <Text style={s.partial} accessibilityLiveRegion="polite">
                {partial}…
              </Text>
            </View>
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
  startCard: { borderWidth: 3, borderColor: C.primary, backgroundColor: C.primaryTint, borderRadius: 12, padding: 18, gap: 10 },
  startTitle: { fontSize: 22, fontWeight: '800', color: C.ink },
  startText: { fontSize: 17, lineHeight: 24, color: C.ink },
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
  tagRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  tag: { fontSize: 14, fontWeight: '700', color: C.primary },
  moved: { fontSize: 13, fontWeight: '700', color: C.ink, backgroundColor: '#fff', borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  qt: { fontSize: 20, fontWeight: '700', lineHeight: 26, color: C.ink, marginBottom: 12 },
  qtTop: { fontSize: 22, lineHeight: 29 },
  acts: { flexDirection: 'row', justifyContent: 'flex-end' },
  foot: { padding: 16 },
});
