import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Banner, Btn, confirm } from '@/components/ui';
import { C } from '@/constants/theme';
import { useTranscription } from '@/hooks/useTranscription';
import { dismissSuggestion, subscribeSuggestions } from '@/lib/api';
import type { Suggestion } from '@/types/api';

const RANK = { high: 0, medium: 1, low: 2 } as const;
const SHOW_ANSWERED_MS = 3000;
const MOVED_UP_MS = 3000;

/** Highest priority first, newest first within a priority; at most 3 (CLAUDE.md §3). */
function rankActive(list: Suggestion[]) {
  return list
    .filter((q) => q.status === 'active')
    .sort((a, b) => RANK[a.priority] - RANK[b.priority] || b.created_at.localeCompare(a.created_at))
    .slice(0, 3);
}

export default function Live() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTranscription({ sessionId: id });
  const [all, setAll] = useState<Suggestion[]>([]);
  const [answered, setAnswered] = useState<Suggestion[]>([]);
  const [movedUp, setMovedUp] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [ending, setEnding] = useState(false);
  const prev = useRef<Suggestion[]>([]);
  const paused = t.status === 'paused';
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    t.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (t.status !== 'live') return;
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, [t.status]);

  useEffect(
    () =>
      subscribeSuggestions(id, (list) => {
        const before = rankActive(prev.current);
        const after = rankActive(list);
        const beforeIds = new Set(before.map((q) => q.id));

        // Auto-clear: a visible card the backend marked answered lingers briefly as "You asked this".
        const justAnswered = list.filter((q) => q.status === 'answered' && beforeIds.has(q.id));
        if (justAnswered.length) {
          setAnswered((a) => [...a, ...justAnswered]);
          setTimeout(() => setAnswered((a) => a.filter((q) => !justAnswered.includes(q))), SHOW_ANSWERED_MS);
        }

        const top = after[0];
        if (top && top.id !== before[0]?.id) {
          if (beforeIds.has(top.id)) {
            setMovedUp(top.id);
            setTimeout(() => setMovedUp((m) => (m === top.id ? null : m)), MOVED_UP_MS);
          }
          // Paused: cards still update, but no buzz and no announcement (spec).
          if (!pausedRef.current) AccessibilityInfo.announceForAccessibility(`New top question: ${top.question}`);
        }
        const newHigh = after.some((q) => q.priority === 'high' && !prev.current.some((p) => p.id === q.id && p.priority === 'high'));
        if (newHigh && !pausedRef.current) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        prev.current = list;
        setAll(list);
      }),
    [id],
  );

  async function dismiss(q: Suggestion) {
    setPending(q.id);
    setFailed(null);
    try {
      await dismissSuggestion(id, q.id);
    } catch {
      setFailed(q.id);
    } finally {
      setPending(null);
    }
  }

  async function end() {
    setEnding(true);
    await t.stop();
    router.replace(`/session/${id}/ending`);
  }

  // Android back / swipe-back must not silently end the recording.
  usePreventRemove(!ending, () => confirm('End consultation?', 'Horus will stop listening and write your summary.', 'End', end));

  const active = rankActive(all);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  const statusLabel = t.status === 'connecting' || t.status === 'idle' ? 'Starting…' : paused ? 'Paused' : 'Listening';

  return (
    <SafeAreaView style={s.root}>
      <View style={s.bar}>
        <View style={s.rec} accessible accessibilityLabel={`${statusLabel}, ${mm} minutes ${ss} seconds`}>
          <View style={[s.dot, paused && s.dotPaused]} />
          <Text style={s.recText}>{statusLabel}</Text>
          <Text style={s.time}>
            {mm}:{ss}
          </Text>
        </View>
        <Btn
          label={paused ? '▶ Resume' : '❚❚ Pause'}
          accessibilityLabel={paused ? 'Resume listening' : 'Pause listening'}
          variant={paused ? 'primary' : 'outline'}
          disabled={t.status !== 'live' && !paused}
          onPress={paused ? t.start : t.pause}
          style={{ minHeight: 48, paddingHorizontal: 14 }}
        />
      </View>

      {paused && <Banner text="Horus isn’t listening. Nothing is being recorded." />}
      {t.error && <Banner text="Not hearing anything. Check the microphone." action={{ label: 'Retry', onPress: t.start }} />}

      <ScrollView contentContainerStyle={s.qs}>
        <Text style={s.h2} accessibilityRole="header">
          Ask your doctor
        </Text>
        {active.length === 0 && answered.length === 0 && (
          <Text style={s.empty}>Listening… questions will appear here.</Text>
        )}
        {active.map((q, i) => (
          <Animated.View key={q.id} layout={LinearTransition} entering={FadeIn} exiting={FadeOut} style={[s.q, i === 0 && s.qTop]}>
            <View style={s.tagRow}>
              <Text style={[s.tag, i > 0 && { color: C.muted }]}>{i === 0 ? '● Ask next' : 'Also worth asking'}</Text>
              {movedUp === q.id && <Text style={s.moved}>↑ Moved up</Text>}
            </View>
            <Text style={[s.qt, i === 0 && s.qtTop]}>{q.question}</Text>
            {failed === q.id && <Text style={s.err}>Didn’t work, try again.</Text>}
            <View style={s.acts}>
              <Btn
                label="Dismiss"
                accessibilityLabel={`Dismiss: ${q.question}`}
                disabled={pending === q.id}
                onPress={() => dismiss(q)}
                style={{ minHeight: 48 }}
              />
            </View>
          </Animated.View>
        ))}
        {answered.map((q) => (
          <Animated.View key={`done-${q.id}`} layout={LinearTransition} entering={FadeIn} exiting={FadeOut} style={[s.q, s.qDone]}>
            <Text style={[s.tag, { color: C.ok }]}>✓ You asked this</Text>
            <Text style={s.qtDone}>{q.question}</Text>
          </Animated.View>
        ))}
      </ScrollView>

      <View style={s.foot}>
        <Btn label={ending ? 'Ending…' : 'End consultation'} variant="ink" onPress={end} disabled={ending} />
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  rec: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: C.rec },
  dotPaused: { backgroundColor: 'transparent', borderWidth: 3, borderColor: C.muted },
  recText: { fontSize: 16, fontWeight: '600', color: C.ink },
  time: { fontSize: 16, fontWeight: '500', color: C.muted, fontVariant: ['tabular-nums'] },
  qs: { paddingHorizontal: 16, paddingBottom: 16, gap: 12 },
  h2: { fontSize: 20, fontWeight: '700', color: C.ink },
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
  err: { fontSize: 15, color: C.danger, fontWeight: '700', marginBottom: 8 },
  foot: { padding: 16 },
});
