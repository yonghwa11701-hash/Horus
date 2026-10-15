import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, confirm } from '@/components/ui';
import { C } from '@/constants/theme';
import { loadSavedAppointment, removeSavedAppointment, saveAppointment } from '@/lib/appointments';
import { discardConsultation, loadConsultation, loadSummary } from '@/lib/consultations';
import type { TranscriptSegment } from '@/types/consultation';

// Output shape of supabase/functions/_shared/prompts/summary.md. Fields are optional: it is model output.
type SummaryPayload = Partial<{
  headline: string;
  important: string[];
  what_the_doctor_found: string[];
  medications: { name: string; how_to_take?: string; notes?: string }[];
  next_steps: string[];
  answered_questions: { question: string; answer: string }[];
  still_to_ask: string[];
  unclear: string[];
}>;

const clock = (ms = 0) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export default function SummaryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [summary, setSummary] = useState<SummaryPayload | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [saved, setSaved] = useState(false);
  const [source, setSource] = useState<'cloud' | 'device'>('cloud');
  const [failed, setFailed] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([loadSummary(id), loadConsultation(id)]).then(
      ([envelope, { session, segments }]) => {
        if (!alive) return;
        const payload = envelope.payload as SummaryPayload;
        setSummary(payload);
        setSegments(segments);
        setSaved(session.status === 'completed');
        void saveAppointment({ id, at: session.ended_at ?? session.updated_at, headline: payload?.headline, summary: payload, segments });
      },
      // Offline, or a new anonymous sign-in (e.g. a new browser tab) can't read it from the cloud: use the device copy.
      async () => {
        const local = await loadSavedAppointment(id);
        if (!alive) return;
        if (!local) return setFailed(true);
        setSummary(local.summary as SummaryPayload);
        setSegments(local.segments);
        setSaved(true);
        setSource('device');
      },
    );
    return () => {
      alive = false;
    };
  }, [id]);

  function done() {
    if (router.canDismiss()) router.dismissAll();
    router.replace('/');
  }

  function del() {
    confirm('Delete this appointment?', 'The transcript and summary will be deleted. This cannot be undone.', 'Delete', async () => {
      setDeleting(true);
      try {
        // A device-only copy has no cloud row this sign-in can delete.
        if (source === 'cloud') await discardConsultation(id);
        await removeSavedAppointment(id);
        done();
      } catch {
        setDeleting(false);
      }
    });
  }

  const empty = summary && !summary.headline && !Object.values(summary).some((v) => Array.isArray(v) && v.length);

  return (
    <SafeAreaView style={s.root}>
      <View style={s.top}>
        <Text style={s.h1} accessibilityRole="header">
          Your appointment
        </Text>
        {saved && <Text style={s.saved}>{source === 'device' ? '✓ Saved on this device' : '✓ Saved'}</Text>}
      </View>

      <ScrollView contentContainerStyle={s.body}>
        <Text style={s.note}>A record of what was said, not medical advice.</Text>

        {failed && <Text style={s.err}>Couldn’t load the summary. Your transcript is saved.</Text>}
        {!summary && !failed && <ActivityIndicator color={C.primary} />}
        {empty && <Text style={s.line}>Nothing to summarise.</Text>}

        {summary?.headline && <Text style={s.headline}>{summary.headline}</Text>}
        {!!summary?.important?.length && (
          <View style={s.important}>
            <Text style={s.h3}>Important</Text>
            {summary.important.map((t, i) => <Text key={i} style={s.line}>• {t}</Text>)}
          </View>
        )}
        <List title="What the doctor found" items={summary?.what_the_doctor_found} />
        {!!summary?.medications?.length && (
          <Section title="Medicines">
            {summary.medications.map((m, i) => (
              <View key={i} style={s.card}>
                <Text style={[s.line, { fontWeight: '700' }]}>{m.name}</Text>
                {m.how_to_take && <Text style={s.line}>{m.how_to_take}</Text>}
                {m.notes && <Text style={s.muted}>{m.notes}</Text>}
              </View>
            ))}
          </Section>
        )}
        <List title="Next steps" items={summary?.next_steps} numbered />
        {!!summary?.answered_questions?.length && (
          <Section title="Questions answered">
            {summary.answered_questions.map((qa, i) => (
              <View key={i} style={s.card}>
                <Text style={[s.line, { fontWeight: '700' }]}>{qa.question}</Text>
                <Text style={s.line}>{qa.answer}</Text>
              </View>
            ))}
          </Section>
        )}
        <List title="Still to ask" items={summary?.still_to_ask} />
        <List title="Not clear from the recording" items={summary?.unclear} />

        <Pressable accessibilityRole="button" onPress={() => setShowTranscript((v) => !v)} style={s.tsToggle}>
          <Text style={s.link}>{showTranscript ? 'Hide full transcript' : 'Show full transcript'}</Text>
        </Pressable>
        {showTranscript &&
          segments.map((seg) => (
            <Text key={seg.id} style={s.seg}>
              <Text style={s.segTime}>{clock(seg.start_ms)}  </Text>
              {seg.text}
            </Text>
          ))}
      </ScrollView>

      <View style={s.foot}>
        <Btn label="Done" variant="primary" onPress={done} />
        <Pressable accessibilityRole="button" onPress={del} disabled={deleting} hitSlop={8} style={s.del}>
          <Text style={s.delText}>{deleting ? 'Deleting…' : 'Delete this appointment'}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.sec}>
      <Text style={s.h3} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function List({ title, items, numbered }: { title: string; items?: string[]; numbered?: boolean }) {
  if (!items?.length) return null;
  return (
    <Section title={title}>
      {items.map((t, i) => (
        <View key={i} style={s.row}>
          <Text style={numbered ? s.n : s.bullet}>{numbered ? i + 1 : '•'}</Text>
          <Text style={[s.line, { flex: 1 }]}>{t}</Text>
        </View>
      ))}
    </Section>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 },
  h1: { fontSize: 26, fontWeight: '800', color: C.ink },
  saved: { fontSize: 14, fontWeight: '700', color: C.ok },
  body: { paddingHorizontal: 16, paddingBottom: 24 },
  note: { fontSize: 14, color: C.muted, backgroundColor: C.surface, borderRadius: 8, padding: 12, marginBottom: 16 },
  err: { fontSize: 16, color: C.danger, fontWeight: '700', marginBottom: 12 },
  headline: { fontSize: 20, fontWeight: '700', lineHeight: 28, color: C.ink, marginBottom: 18 },
  important: { borderLeftWidth: 4, borderLeftColor: C.danger, backgroundColor: C.surface, borderRadius: 8, padding: 12, marginBottom: 18 },
  sec: { marginBottom: 18 },
  h3: { fontSize: 18, fontWeight: '800', color: C.ink, marginBottom: 8 },
  row: { flexDirection: 'row', gap: 10, marginBottom: 8 },
  bullet: { fontSize: 17, lineHeight: 25, color: C.ink },
  n: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: C.ink, textAlign: 'center', lineHeight: 24, fontWeight: '800', fontSize: 14, color: C.ink },
  card: { borderWidth: 2, borderColor: C.line, borderRadius: 12, padding: 12, marginBottom: 8, gap: 4 },
  line: { fontSize: 17, lineHeight: 25, color: C.ink },
  muted: { fontSize: 15, lineHeight: 22, color: C.muted },
  tsToggle: { minHeight: 48, justifyContent: 'center' },
  link: { fontSize: 16, fontWeight: '700', color: C.primary, textDecorationLine: 'underline' },
  seg: { fontSize: 17, lineHeight: 25, color: C.ink, marginBottom: 10 },
  segTime: { fontSize: 14, fontWeight: '700', color: C.muted },
  foot: { padding: 16, borderTopWidth: 1, borderTopColor: C.line },
  del: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  delText: { fontSize: 15, fontWeight: '700', color: C.danger, textDecorationLine: 'underline' },
});
