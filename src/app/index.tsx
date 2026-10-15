import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn } from '@/components/ui';
import { C } from '@/constants/theme';
import { loadSummary } from '@/lib/consultations';
import { ensureAnonymousSession, getSupabase } from '@/lib/supabase';

type LastAppointment = { id: string; when: string; headline?: string };

// RLS (sessions_owner_read) limits this to the current anonymous user's sessions.
async function loadLastAppointment(): Promise<LastAppointment | null> {
  await ensureAnonymousSession();
  const { data } = await getSupabase().from('sessions').select('id, ended_at, updated_at')
    .eq('status', 'completed').order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  const when = new Date(data.ended_at ?? data.updated_at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const headline = await loadSummary(data.id).then((e) => (e.payload as { headline?: string } | null)?.headline, () => undefined);
  return { id: data.id, when, headline };
}

export default function Home() {
  const [last, setLast] = useState<LastAppointment | null>(null);

  // Refresh on every visit so a just-finished appointment shows when the patient returns Home.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      loadLastAppointment().then((a) => alive && setLast(a), () => {});
      return () => {
        alive = false;
      };
    }, []),
  );

  return (
    <SafeAreaView style={s.root}>
      <View style={s.hero}>
        <Text style={s.brand} accessibilityRole="header">HORUS</Text>
        <Text style={s.h1}>Ask the right questions at your appointment.</Text>
        <Text style={s.body}>
          Horus listens and suggests questions. You’ll feel a buzz when there’s one worth asking. Afterwards you get a
          summary of what was said.
        </Text>
      </View>
      <View style={s.foot}>
        {last && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Last appointment, ${last.when}. ${last.headline ?? ''} Open summary`}
            onPress={() => router.push(`/session/${last.id}/summary`)}
            style={({ pressed }) => [s.last, pressed && { opacity: 0.85 }]}>
            <Text style={s.lastLabel}>Last appointment · {last.when}</Text>
            {last.headline && <Text style={s.lastHeadline} numberOfLines={2}>{last.headline}</Text>}
            <Text style={s.lastLink}>View summary ›</Text>
          </Pressable>
        )}
        <Btn
          label="● Start consultation"
          variant="primary"
          onPress={() => router.push('/consent')}
          accessibilityLabel="Start consultation"
          style={{ minHeight: 60 }}
        />
        <Text style={s.small}>Horus doesn’t give medical advice.</Text>
        {/* Team's voice pipeline debug screen; tabs were removed, so dev builds reach it from here. */}
        {__DEV__ && (
          <Text accessibilityRole="link" onPress={() => router.push('/voice-debug')} style={[s.small, { textDecorationLine: 'underline', paddingVertical: 12 }]}>
            Voice debug
          </Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  hero: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  brand: { fontSize: 15, fontWeight: '800', letterSpacing: 2, color: C.primary, marginBottom: 14 },
  h1: { fontSize: 32, fontWeight: '800', lineHeight: 38, color: C.ink, marginBottom: 14 },
  body: { fontSize: 17, lineHeight: 25, color: C.muted },
  foot: { padding: 16, gap: 10 },
  small: { fontSize: 14, color: C.muted, textAlign: 'center' },
  last: { borderWidth: 2, borderColor: C.line, borderRadius: 12, padding: 14, gap: 4, minHeight: 48 },
  lastLabel: { fontSize: 14, fontWeight: '700', color: C.muted },
  lastHeadline: { fontSize: 17, lineHeight: 24, fontWeight: '600', color: C.ink },
  lastLink: { fontSize: 16, fontWeight: '700', color: C.primary, textDecorationLine: 'underline' },
});
