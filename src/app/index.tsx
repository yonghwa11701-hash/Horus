import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn } from '@/components/ui';
import { C } from '@/constants/theme';
import { loadAppointments, type Appointment } from '@/lib/appointments';

const MAX_APPOINTMENTS = 20;
const SIDE_PADDING = 24;

const when = (at: Date) =>
  at.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const shortDay = (at: Date) => at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const shortTime = (at: Date) => at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export default function Home() {
  const [appointments, setAppointments] = useState<Appointment[]>([]); // newest first
  const [active, setActive] = useState(0);
  const [cardWidth, setCardWidth] = useState(0);
  const carousel = useRef<ScrollView>(null);

  // Refresh on every visit so a just-finished appointment shows when the patient returns Home.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      loadAppointments(MAX_APPOINTMENTS).then((a) => {
        if (!alive) return;
        setAppointments(a);
        setActive(0);
        carousel.current?.scrollTo({ x: 0, animated: false });
      }, () => {});
      return () => {
        alive = false;
      };
    }, []),
  );

  function show(index: number) {
    setActive(index);
    carousel.current?.scrollTo({ x: index * cardWidth, animated: true });
  }

  const has = appointments.length > 0;
  // Timeline reads left to right in time order: oldest first, newest last.
  const chronological = appointments.map((a, i) => ({ a, i })).reverse();

  return (
    <SafeAreaView style={s.root}>
      <View style={[s.hero, !has && s.centered]}>
        <Text style={s.brand} accessibilityRole="header">HORUS</Text>
        <Text style={s.h1}>Ask the right questions at your appointment.</Text>
        <Text style={s.body}>
          Horus listens and suggests questions. You’ll feel a buzz when there’s one worth asking. Afterwards you get a
          summary of what was said.
        </Text>
      </View>

      {has && (
        <View style={s.appointments}>
          <Text style={s.h2} accessibilityRole="header">
            Past appointments
          </Text>
          <View onLayout={(e) => setCardWidth(e.nativeEvent.layout.width)}>
            <ScrollView
              ref={carousel}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              scrollEventThrottle={50}
              onScroll={(e) => cardWidth && setActive(Math.round(e.nativeEvent.contentOffset.x / cardWidth))}>
              {appointments.map((a, i) => (
                <View key={a.id} style={{ width: cardWidth }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Appointment ${i + 1} of ${appointments.length}, ${when(a.at)}. ${a.headline ?? ''} Open summary`}
                    onPress={() => router.push(`/session/${a.id}/summary`)}
                    style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]}>
                    <Text style={s.cardWhen}>{when(a.at)}</Text>
                    <Text style={s.cardHeadline} numberOfLines={3}>
                      {a.headline ?? 'Summary'}
                    </Text>
                    <Text style={s.link}>View summary ›</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          </View>
          {appointments.length > 1 && <Text style={s.hint}>Swipe for other appointments</Text>}
        </View>
      )}

      <View style={s.spacer} />

      {has && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.timeline}>
          {chronological.map(({ a, i }, pos) => {
            const selected = i === active;
            return (
              <Pressable
                key={a.id}
                accessibilityRole="button"
                accessibilityLabel={`Show appointment from ${when(a.at)}`}
                accessibilityState={{ selected }}
                onPress={() => show(i)}
                style={s.stop}>
                <View style={s.track}>
                  <View style={[s.segment, pos === 0 && s.segmentHidden]} />
                  <View style={[s.dot, selected && s.dotSelected]} />
                  <View style={[s.segment, pos === chronological.length - 1 && s.segmentHidden]} />
                </View>
                <Text style={[s.stopDay, selected && s.stopSelected]}>{shortDay(a.at)}</Text>
                <Text style={[s.stopTime, selected && s.stopSelected]}>{shortTime(a.at)}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

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
  hero: { paddingHorizontal: SIDE_PADDING, paddingTop: 32 },
  centered: { flex: 1, justifyContent: 'center', paddingTop: 0 },
  brand: { fontSize: 15, fontWeight: '800', letterSpacing: 2, color: C.primary, marginBottom: 14 },
  h1: { fontSize: 32, fontWeight: '800', lineHeight: 38, color: C.ink, marginBottom: 14 },
  body: { fontSize: 17, lineHeight: 25, color: C.muted },
  appointments: { paddingHorizontal: SIDE_PADDING, marginTop: 24, gap: 10 },
  h2: { fontSize: 18, fontWeight: '800', color: C.ink },
  card: { borderWidth: 2, borderColor: C.line, borderRadius: 12, padding: 16, gap: 6 },
  cardWhen: { fontSize: 14, fontWeight: '700', color: C.muted },
  cardHeadline: { fontSize: 18, lineHeight: 26, fontWeight: '600', color: C.ink },
  link: { fontSize: 16, fontWeight: '700', color: C.primary, textDecorationLine: 'underline' },
  hint: { fontSize: 14, color: C.muted },
  spacer: { flex: 1 },
  timeline: { paddingHorizontal: SIDE_PADDING - 8 },
  stop: { width: 76, alignItems: 'center', paddingBottom: 4 },
  track: { flexDirection: 'row', alignItems: 'center', height: 48, alignSelf: 'stretch' },
  segment: { flex: 1, height: 2, backgroundColor: C.line },
  segmentHidden: { backgroundColor: 'transparent' },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: C.primary, backgroundColor: C.bg },
  dotSelected: { width: 18, height: 18, borderRadius: 9, backgroundColor: C.primary },
  stopDay: { fontSize: 14, fontWeight: '600', color: C.muted },
  stopTime: { fontSize: 14, color: C.muted },
  stopSelected: { color: C.ink, fontWeight: '800' },
  foot: { padding: 16, gap: 10 },
  small: { fontSize: 14, color: C.muted, textAlign: 'center' },
});
