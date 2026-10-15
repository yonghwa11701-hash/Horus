import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Banner } from '@/components/ui';
import { C } from '@/constants/theme';
import { ConsultationApiError, finalizeConsultation, loadConsultation, subscribeToConsultation } from '@/lib/consultations';

function failureText(e: unknown) {
  // Browsers report an undeployed function as unreachable (failed CORS preflight), native as not deployed.
  if (e instanceof ConsultationApiError && (e.code === 'function_not_deployed' || e.code === 'service_unreachable')) {
    return 'The summary service isn’t available right now. Your transcript is saved.';
  }
  return `Couldn’t write the summary: ${e instanceof Error ? e.message : String(e)} Your transcript is saved.`;
}

export default function Ending() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    let finished = false;
    let unsubscribe: (() => void) | undefined;
    const done = () => {
      if (!alive || finished) return;
      finished = true;
      router.replace(`/session/${id}/summary`);
    };

    // summary.ready = sessions UPDATE status=completed (types/consultation.ts).
    subscribeToConsultation(id, {
      onSession: (session) => session.status === 'completed' && done(),
      onStatus: (status) => {
        if (status === 'SUBSCRIBED') loadConsultation(id).then(({ session }) => session.status === 'completed' && done(), () => {});
      },
    }).then((u) => (alive ? (unsubscribe = u) : u()), () => {});
    // Live updates are optional: a connection failure does not mean finalization failed.
    // Successful finalization confirms completion even if its Realtime event is missed.
    finalizeConsultation(id).then(done, (e) => alive && !finished && setProblem(failureText(e)));

    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [id, attempt]);

  return (
    <SafeAreaView style={s.root}>
      <View style={s.body}>
        <Text style={s.h1} accessibilityRole="header">
          Preparing your summary
        </Text>
        <Text style={s.sub}>This can take a few minutes. We’ll open it when it’s ready.</Text>
        <Step done label="Transcript saved" />
        <Step label="Finishing transcript checks and writing your summary" />
      </View>
      {problem && (
        <Banner
          text={problem}
          action={{ label: 'Try again', onPress: () => (setProblem(null), setAttempt((a) => a + 1)) }}
        />
      )}
    </SafeAreaView>
  );
}

function Step({ done, label }: { done?: boolean; label: string }) {
  return (
    <View style={s.step} accessible accessibilityLabel={`${label}, ${done ? 'done' : 'in progress'}`}>
      {done ? (
        <View style={s.tick}>
          <Text style={s.tickText}>✓</Text>
        </View>
      ) : (
        <ActivityIndicator color={C.primary} style={{ width: 28 }} />
      )}
      <Text style={[s.stepText, !done && { fontWeight: '700' }]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  body: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  h1: { fontSize: 28, fontWeight: '800', color: C.ink, marginBottom: 8 },
  sub: { fontSize: 17, color: C.muted, marginBottom: 28 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 16 },
  tick: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.ok, alignItems: 'center', justifyContent: 'center' },
  tickText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  stepText: { flex: 1, fontSize: 17, lineHeight: 24, color: C.ink },
});
