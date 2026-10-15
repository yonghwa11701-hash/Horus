import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn } from '@/components/ui';
import { C } from '@/constants/theme';
import { createConsultation } from '@/lib/consultations';

// Shown before every consultation: each appointment may be a different doctor (CLAUDE.md §2).
export default function Consent() {
  const [sessionId] = useState(() => randomUUID()); // reused on retry so a retry is the same consultation
  const [agreed, setAgreed] = useState(false);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Leaving mid-request would let the pending result open Live anyway.
  usePreventRemove(pending && !created, () => {});
  useEffect(() => {
    // Navigate after the successful render has released the pending-request guard.
    if (created) router.replace(`/session/${sessionId}`);
  }, [created, sessionId]);

  async function start() {
    setPending(true);
    setError(null);
    try {
      await createConsultation(agreed, sessionId);
      setCreated(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t start. Try again.');
      setPending(false);
    }
  }

  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={s.body}>
        <Text style={s.h1} accessibilityRole="header">
          Before you start
        </Text>

        <Point title="Not medical advice" text="Horus suggests questions for you to ask. It doesn’t diagnose or recommend treatment." />
        <Point title="Your data" text="Your transcript and summary are saved. You can delete them at the end of the appointment." />
        <Point title="Microphone" text="Next, your phone will ask to use the microphone so Horus can listen." />

        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: agreed, disabled: pending }}
          disabled={pending}
          onPress={() => setAgreed((a) => !a)}
          style={[s.check, agreed && s.checkOn]}>
          <View style={[s.box, agreed && s.boxOn]}>{agreed && <Text style={s.tick}>✓</Text>}</View>
          <Text style={s.checkText}>I’ve asked my doctor and they’re happy for Horus to listen.</Text>
        </Pressable>
      </ScrollView>

      <View style={s.foot}>
        {error && <Text style={s.err}>{error}</Text>}
        <Btn
          label={pending ? 'Starting…' : '● Start listening'}
          accessibilityLabel="Start listening"
          variant="primary"
          disabled={!agreed || pending}
          onPress={start}
          style={{ minHeight: 60 }}
        />
        <Btn label="Back" disabled={pending} onPress={() => router.back()} />
      </View>
    </SafeAreaView>
  );
}

function Point({ title, text }: { title: string; text: string }) {
  return (
    <View style={s.point}>
      <Text style={s.pointTitle}>{title}</Text>
      <Text style={s.pointText}>{text}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  body: { padding: 24, gap: 18 },
  h1: { fontSize: 28, fontWeight: '800', color: C.ink, marginBottom: 4 },
  point: { gap: 4 },
  pointTitle: { fontSize: 18, fontWeight: '800', color: C.ink },
  pointText: { fontSize: 17, lineHeight: 25, color: C.ink },
  check: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 64, padding: 14, borderRadius: 12, borderWidth: 2, borderColor: C.line, marginTop: 8 },
  checkOn: { borderColor: C.primary, backgroundColor: C.primaryTint },
  box: { width: 28, height: 28, borderRadius: 6, borderWidth: 2, borderColor: C.ink, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  boxOn: { backgroundColor: C.primary, borderColor: C.primary },
  tick: { color: '#fff', fontWeight: '800', fontSize: 17 },
  checkText: { flex: 1, fontSize: 17, lineHeight: 24, fontWeight: '700', color: C.ink },
  foot: { padding: 16, gap: 10 },
  err: { fontSize: 15, color: C.danger, fontWeight: '700' },
});
