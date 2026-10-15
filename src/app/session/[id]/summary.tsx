import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, confirm } from '@/components/ui';
import { C } from '@/constants/theme';
import { getSegments, getSummary, retainSession } from '@/lib/api';
import type { Summary, SummaryLine, TranscriptSegment } from '@/types/api';

const SECTIONS: { kind: SummaryLine['kind']; title: string }[] = [
  { kind: 'summary', title: 'What was said' },
  { kind: 'next_step', title: 'Next steps the doctor gave' },
  { kind: 'outstanding', title: 'Still unanswered' },
];

const clock = (ms = 0) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export default function SummaryScreen() {
  const { id, summaryId } = useLocalSearchParams<{ id: string; summaryId: string }>();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [source, setSource] = useState<number | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    Promise.all([getSummary(id, summaryId), getSegments(id)])
      .then(([sum, segs]) => {
        setSummary(sum);
        setSegments([...segs].sort((a, b) => a.seq - b.seq));
      })
      .catch(() => setFailed(true));
    // Saved by default; the patient can still delete below (spec, CLAUDE.md §2.4).
    retainSession(id, true).then(() => setSaved(true), () => {});
  }, [id, summaryId]);

  // One citation number per unique segment id, in reading order.
  const citeNo = new Map<number, number>();
  summary?.lines.forEach((l) => l.segment_ids.forEach((sid) => citeNo.has(sid) || citeNo.set(sid, citeNo.size + 1)));

  function done() {
    if (router.canDismiss()) router.dismissAll();
    router.replace('/');
  }

  function del() {
    confirm('Delete this appointment?', 'The transcript and summary will be deleted. This cannot be undone.', 'Delete', async () => {
      setDeleting(true);
      try {
        await retainSession(id, false);
        done();
      } catch {
        setDeleting(false);
      }
    });
  }

  return (
    <SafeAreaView style={s.root}>
      <View style={s.top}>
        <View style={s.titleRow}>
          <Text style={s.h1} accessibilityRole="header">
            Your appointment
          </Text>
          {saved && <Text style={s.saved}>✓ Saved</Text>}
        </View>
      </View>

      <ScrollView contentContainerStyle={s.body}>
        <Text style={s.note}>A record of what was said, not medical advice.</Text>

        {failed && <Text style={s.err}>Couldn’t load the summary. Your transcript is saved.</Text>}
        {!summary && !failed && <ActivityIndicator color={C.primary} />}
        {summary && summary.lines.length === 0 && <Text style={s.line}>Nothing to summarise.</Text>}

        {summary &&
          SECTIONS.map(({ kind, title }) => {
            const lines = summary.lines.filter((l) => l.kind === kind);
            if (!lines.length) return null;
            return (
              <View key={kind} style={s.sec}>
                <Text style={s.h3} accessibilityRole="header">
                  {title}
                </Text>
                {lines.map((l, i) => (
                  <View key={i} style={kind === 'outstanding' ? s.out : s.lineRow}>
                    {kind === 'next_step' && <Text style={s.n}>{i + 1}</Text>}
                    <Text style={[s.line, { flex: 1 }, kind === 'outstanding' && { fontWeight: '700' }]}>
                      {l.text}{' '}
                      {l.segment_ids.map((sid) => (
                        <Text
                          key={sid}
                          accessibilityRole="link"
                          accessibilityLabel={`Source ${citeNo.get(sid)}`}
                          onPress={() => setSource(sid)}
                          style={s.cite}>
                          {' '}
                          {citeNo.get(sid)}{' '}
                        </Text>
                      ))}
                    </Text>
                  </View>
                ))}
              </View>
            );
          })}

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
        <Btn label="Done" onPress={done} />
        <Pressable accessibilityRole="button" onPress={del} disabled={deleting} hitSlop={8} style={s.del}>
          <Text style={s.delText}>{deleting ? 'Deleting…' : 'Delete this appointment'}</Text>
        </Pressable>
      </View>

      <SourceSheet segments={segments} segmentId={source} number={source ? citeNo.get(source) : undefined} onClose={() => setSource(null)} />
    </SafeAreaView>
  );
}

/** RN Modal traps screen-reader focus and returns it on close (spec). */
function SourceSheet({ segments, segmentId, number, onClose }: { segments: TranscriptSegment[]; segmentId: number | null; number?: number; onClose: () => void }) {
  const i = segments.findIndex((x) => x.id === segmentId);
  // Neighbours by seq within this session, not id ± 1.
  const context = i < 0 ? [] : segments.slice(Math.max(0, i - 1), i + 2);
  return (
    <Modal visible={segmentId !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} accessibilityLabel="Close source" />
      <View style={s.sheet}>
        <Text style={s.h3} accessibilityRole="header">
          Source {number}
        </Text>
        <Text style={s.sheetSub}>From the transcript, with the line before and after</Text>
        {i < 0 && <Text style={s.line}>This part of the transcript isn’t available.</Text>}
        {context.map((seg) => {
          const hit = seg.id === segmentId;
          return (
            <View key={seg.id} style={[s.ctx, hit && s.ctxHit]}>
              <Text style={s.segTime}>
                {clock(seg.start_ms)}
                {hit ? ' · cited' : ''}
              </Text>
              <Text style={s.line}>{seg.text}</Text>
            </View>
          );
        })}
        <Btn label="Close" onPress={onClose} style={{ marginTop: 12 }} />
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  top: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  h1: { fontSize: 26, fontWeight: '800', color: C.ink },
  saved: { fontSize: 14, fontWeight: '700', color: C.ok },
  body: { paddingHorizontal: 16, paddingBottom: 24 },
  note: { fontSize: 14, color: C.muted, backgroundColor: C.surface, borderRadius: 8, padding: 12, marginBottom: 16 },
  err: { fontSize: 16, color: C.danger, fontWeight: '700', marginBottom: 12 },
  sec: { marginBottom: 18 },
  h3: { fontSize: 18, fontWeight: '800', color: C.ink, marginBottom: 8 },
  lineRow: { flexDirection: 'row', gap: 10, marginBottom: 8 },
  out: { borderWidth: 2, borderColor: C.line, borderRadius: 12, padding: 12, marginBottom: 8 },
  n: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: C.ink, textAlign: 'center', lineHeight: 24, fontWeight: '800', fontSize: 14, color: C.ink },
  line: { fontSize: 17, lineHeight: 25, color: C.ink },
  cite: { fontSize: 15, fontWeight: '800', color: C.primary, backgroundColor: C.primaryTint, textDecorationLine: 'underline' },
  tsToggle: { minHeight: 48, justifyContent: 'center' },
  link: { fontSize: 16, fontWeight: '700', color: C.primary, textDecorationLine: 'underline' },
  seg: { fontSize: 17, lineHeight: 25, color: C.ink, marginBottom: 10 },
  segTime: { fontSize: 14, fontWeight: '700', color: C.muted },
  foot: { padding: 16, borderTopWidth: 1, borderTopColor: C.line },
  del: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  delText: { fontSize: 15, fontWeight: '700', color: C.danger, textDecorationLine: 'underline' },
  scrim: { flex: 1, backgroundColor: 'rgba(11,18,32,0.45)' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 18, paddingBottom: 28 },
  sheetSub: { fontSize: 14, color: C.muted, marginBottom: 12 },
  ctx: { padding: 10, borderRadius: 8, marginBottom: 6 },
  ctxHit: { backgroundColor: C.primaryTint, borderLeftWidth: 4, borderLeftColor: C.primary },
});
