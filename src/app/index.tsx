import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn } from '@/components/ui';
import { C } from '@/constants/theme';

export default function Home() {
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
});
