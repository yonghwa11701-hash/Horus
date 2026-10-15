import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Banner } from '@/components/ui';
import { C } from '@/constants/theme';
import { finalizeSession } from '@/lib/api';

const TIMEOUT_MS = 60_000;

export default function Ending() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [stuck, setStuck] = useState(false);

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => alive && setStuck(true), TIMEOUT_MS);
    // finalize-session returns summary_id; fetch it directly rather than wait on summary.ready (spec).
    finalizeSession(id)
      .then(({ summary_id }) => alive && router.replace({ pathname: '/session/[id]/summary', params: { id, summaryId: summary_id } }))
      .catch(() => alive && setStuck(true))
      .finally(() => clearTimeout(timer));
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, attempt]);

  return (
    <SafeAreaView style={s.root}>
      <View style={s.body}>
        <Text style={s.h1} accessibilityRole="header">
          Writing your summary
        </Text>
        <Text style={s.sub}>This usually takes under a minute.</Text>
        <Step done label="Transcript saved" />
        <Step label="Writing the summary and checking every line against the transcript" />
      </View>
      {stuck && <Banner text="This is taking longer than usual. Your transcript is saved." action={{ label: 'Try again', onPress: () => (setStuck(false), setAttempt((a) => a + 1)) }} />}
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
