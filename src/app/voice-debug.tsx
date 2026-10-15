import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useConsultationVoice } from '@/hooks/use-consultation-voice';
import {
  appendFinalTranscript, createConsultation, finalizeConsultation, loadConsultation,
  loadSummary, loadTranscriptCursor, retryPendingSegments, subscribeToConsultation,
} from '@/lib/consultations';
import type { Session, Suggestion, TranscriptSegment } from '@/types/consultation';

export default function VoiceDebugScreen() {
  const [consent, setConsent] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const creationId = useRef<string | null>(null);
  const configured = !!process.env.EXPO_PUBLIC_SUPABASE_URL && !!process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  async function create() {
    setBusy(true);
    setError('');
    try {
      creationId.current ??= randomUUID();
      const result = await createConsultation(consent, creationId.current);
      setSession(result.session);
      creationId.current = null;
    } catch (value) { setError(message(value)); }
    finally { setBusy(false); }
  }

  return (
    <ThemedView style={styles.fill}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <ThemedText type="subtitle">Voice pipeline debug</ThemedText>
        <ThemedText>Synthetic scenarios only. Audio is streamed to ElevenLabs, not saved by Horus. Transcripts and JSON outputs are saved privately.</ThemedText>
        {!configured && <ThemedText>Setup needed: put EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY in Horus/.env, then restart Expo. Apply Supabase migrations, enable anonymous Auth and deploy the Edge Functions.</ThemedText>}
        {error ? <ThemedText style={styles.error}>{error}</ThemedText> : null}
        {!session ? <>
          <View style={styles.row}>
            <Switch value={consent} onValueChange={setConsent} accessibilityLabel="All speakers consent to transcription and AI processing" />
            <ThemedText style={styles.fill}>All speakers consent to transcription and AI processing.</ThemedText>
          </View>
          <Button title={busy ? 'Creating…' : 'Create consultation'} disabled={!configured || !consent || busy} onPress={() => void create()} />
        </> : <SessionDebug key={session.id} initialSession={session} onDiscard={() => setSession(null)} />}
      </ScrollView>
    </ThemedView>
  );
}

function SessionDebug({ initialSession, onDiscard }: { initialSession: Session; onDiscard: () => void }) {
  const [session, setSession] = useState(initialSession);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [realtime, setRealtime] = useState('connecting');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState('');
  const [demoText, setDemoText] = useState('The doctor suggested a new medication. What side effects should I watch for?');
  const voice = useConsultationVoice({
    sessionId: session.id,
    onSegment: (segment) => setSegments((current) => mergeSegment(current, segment)),
    onError: (value) => setError(value.message),
  });

  const refresh = useCallback(async () => {
    const state = await loadConsultation(initialSession.id);
    setSession(state.session);
    setSegments(state.segments);
    setSuggestions(state.suggestions);
  }, [initialSession.id]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void subscribeToConsultation(initialSession.id, {
      onSession: setSession,
      onTranscript: (segment) => setSegments((current) => mergeSegment(current, segment)),
      onSuggestion: (suggestion) => setSuggestions((current) => [
        ...current.filter((item) => item.question_id !== suggestion.question_id), suggestion,
      ]),
      onStatus: (status) => {
        if (disposed) return;
        setRealtime(status);
        if (status === 'SUBSCRIBED') void refresh().catch((value) => setError(message(value)));
      },
    }).then((cleanup) => { if (disposed) cleanup(); else unsubscribe = cleanup; })
      .catch((value) => { if (!disposed) setError(message(value)); });
    return () => { disposed = true; unsubscribe?.(); };
  }, [initialSession.id, refresh]);

  async function run(action: () => Promise<unknown>, success = '') {
    setBusy(true); setError(''); setNotice('');
    try { await action(); if (success) setNotice(success); }
    catch (value) { setError(message(value)); }
    finally { setBusy(false); }
  }
  const recording = voice.phase === 'recording';
  const locked = busy || voice.phase === 'starting' || voice.phase === 'stopping';
  const ended = session.status === 'ending' || session.status === 'completed' || session.status === 'discarding';

  return <>
    <ThemedText type="code" selectable>Session: {session.id}</ThemedText>
    <ThemedText>Session: {session.status} · Voice: {voice.phase}{'\n'}Realtime: {realtime} · Unsaved segments: {voice.pendingCount}</ThemedText>
    {error ? <ThemedText style={styles.error}>{error}</ThemedText> : null}
    {notice ? <ThemedText>{notice}</ThemedText> : null}
    <Button title="Start / resume microphone" disabled={locked || recording || ended} onPress={() => void run(async () => { await voice.start(); await refresh(); })} />
    <Button title="Pause (flush & save)" disabled={locked || !recording} onPress={() => void run(async () => { const result = await voice.pause(); setSession(result.session); })} />
    <Button title="End & save transcript" disabled={locked || ended} onPress={() => void run(async () => { const result = await voice.end(); setSession(result.session); }, 'Transcript and audit snapshots saved.')} />
    <Button title="Retry unsaved segments" disabled={locked || !voice.pendingCount} onPress={() => void run(voice.flush, 'Pending transcript writes retried.')} />
    <Button title="Refresh stored data" disabled={locked} onPress={() => void run(refresh)} />
    <ThemedText type="smallBold">Live partial (not persisted)</ThemedText>
    <ThemedText>{voice.partialTranscript || '—'}</ThemedText>
    <ThemedText type="smallBold">Final transcript ({segments.length})</ThemedText>
    {segments.slice(-20).map((segment) => <ThemedText key={segment.id} selectable>
      #{segment.sequence} [{segment.start_ms}–{segment.end_ms} ms] ({segment.processing_status}) {segment.text}
    </ThemedText>)}
    <ThemedText type="smallBold">Manual synthetic fallback</ThemedText>
    <TextInput style={styles.input} value={demoText} onChangeText={setDemoText} multiline accessibilityLabel="Synthetic transcript text" />
    <Button title="Submit synthetic final segment" disabled={locked || recording || session.status !== 'active' || !demoText.trim()} onPress={() => void run(async () => {
      const cursor = await loadTranscriptCursor(session.id);
      const result = await appendFinalTranscript({
        id: randomUUID(), session_id: session.id, sequence: cursor.sequence, text: demoText.trim(),
        start_ms: cursor.offsetMs, end_ms: cursor.offsetMs + 3000, source: 'manual_demo',
      });
      setSegments((current) => mergeSegment(current, result.segment));
      setNotice(`Transcript persisted; agent dispatch: ${result.agent_dispatch}.`);
    })} />
    <ThemedText type="smallBold">AI integration (Person 3 required)</ThemedText>
    <Button title="Retry pending AI segments" disabled={locked} onPress={() => void run(async () => { await retryPendingSegments(session.id); await refresh(); }, 'Pending AI handoffs retried. Dispatch must be enabled on the server.')} />
    {suggestions.map((suggestion) => <ThemedText key={suggestion.question_id}>[{suggestion.priority} / {suggestion.status}] {suggestion.question}</ThemedText>)}
    <Button title="Generate summary" disabled={locked || session.status !== 'ending'} onPress={() => void run(async () => { await finalizeConsultation(session.id); await refresh(); })} />
    <Button title="Load private summary JSON" disabled={locked || session.status !== 'completed'} onPress={() => void run(async () => { setSummary(JSON.stringify(await loadSummary(session.id), null, 2)); })} />
    {summary ? <ThemedText type="code" selectable>{summary}</ThemedText> : null}
    <Button title="Discard session & delete files" color="#c62828" disabled={locked} onPress={() => void run(async () => { await voice.discard(); onDiscard(); })} />
  </>;
}

function mergeSegment(current: TranscriptSegment[], segment: TranscriptSegment) {
  return [...current.filter((item) => item.id !== segment.id), segment].sort((a, b) => a.sequence - b.sequence);
}
function message(value: unknown) { return value instanceof Error ? value.message : 'The operation failed.'; }
const styles = StyleSheet.create({
  fill: { flex: 1 },
  page: { padding: 24, paddingTop: 64, paddingBottom: 160, gap: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  error: { color: '#c62828' },
  input: { backgroundColor: '#fff', color: '#111', borderWidth: 1, borderColor: '#888', borderRadius: 6, padding: 12, minHeight: 80 },
});
