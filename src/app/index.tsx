import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn } from '@/components/ui';
import { C } from '@/constants/theme';
import { loadAppointments, type Appointment } from '@/lib/appointments';

const MAX_APPOINTMENTS = 20;

const when = (at: Date) =>
  at.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function Home() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);

  // Refresh on every visit so a just-finished appointment shows when the patient returns Home.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      loadAppointments(MAX_APPOINTMENTS).then((a) => alive && setAppointments(a), () => {});
      return () => {
        alive = false;
      };
    }, []),
  );

  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={[s.scroll, appointments.length === 0 && s.centered]}>
        <Text style={s.brand} accessibilityRole="header">HORUS</Text>
        <Text style={s.h1}>Ask the right questions at your appointment.</Text>
        <Text style={s.body}>
          Horus listens and suggests questions. You’ll feel a buzz when there’s one worth asking. Afterwards you get a
          summary of what was said.
        </Text>

        {appointments.length > 0 && (
          <View style={s.timeline}>
            <Text style={s.h2} accessibilityRole="header">
              Past appointments
            </Text>
            {appointments.map((a, i) => (
              <Pressable
                key={a.id}
                accessibilityRole="button"
                accessibilityLabel={`${when(a.at)}. ${a.headline ?? ''} Open summary`}
                onPress={() => router.push(`/session/${a.id}/summary`)}
                style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}>
                <View style={s.rail}>
                  <View style={[s.dot, i === 0 && s.dotLatest]} />
                  {i < appointments.length - 1 && <View style={s.line} />}
                </View>
                <View style={s.entry}>
                  <Text style={s.when}>{when(a.at)}</Text>
                  <Text style={s.headline} numberOfLines={1}>
                    {a.headline ?? 'View summary'}
                  </Text>
                </View>
                <Text style={s.chevron}>›</Text>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>

      <View style={s.foot}>
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
  scroll: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 32, paddingBottom: 16 },
  centered: { justifyContent: 'center' },
  brand: { fontSize: 15, fontWeight: '800', letterSpacing: 2, color: C.primary, marginBottom: 14 },
  h1: { fontSize: 32, fontWeight: '800', lineHeight: 38, color: C.ink, marginBottom: 14 },
  body: { fontSize: 17, lineHeight: 25, color: C.muted },
  timeline: { marginTop: 28 },
  h2: { fontSize: 18, fontWeight: '800', color: C.ink, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'stretch', gap: 12, minHeight: 56 },
  rail: { width: 14, alignItems: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: C.primary, backgroundColor: C.bg, marginTop: 16 },
  dotLatest: { backgroundColor: C.primary },
  line: { flex: 1, width: 2, backgroundColor: C.line },
  entry: { flex: 1, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line, gap: 2 },
  when: { fontSize: 14, fontWeight: '700', color: C.muted },
  headline: { fontSize: 16, lineHeight: 22, fontWeight: '600', color: C.ink },
  chevron: { fontSize: 22, color: C.muted, alignSelf: 'center' },
  foot: { padding: 16, gap: 10 },
  small: { fontSize: 14, color: C.muted, textAlign: 'center' },
});
