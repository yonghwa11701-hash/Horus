import { Alert, Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { C } from '@/constants/theme';

type Variant = 'primary' | 'ink' | 'soft' | 'outline';

const fill: Record<Variant, { bg: string; fg: string; border?: string }> = {
  primary: { bg: C.primary, fg: '#fff' },
  ink: { bg: C.ink, fg: '#fff' },
  soft: { bg: C.chip, fg: C.ink },
  outline: { bg: '#fff', fg: C.ink, border: C.ink },
};

export function Btn({
  label,
  onPress,
  variant = 'soft',
  disabled,
  accessibilityLabel,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: ViewStyle;
}) {
  const f = fill[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.btn,
        { backgroundColor: f.bg, borderColor: f.border ?? f.bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        style,
      ]}>
      <Text style={[s.label, { color: f.fg }]}>{label}</Text>
    </Pressable>
  );
}

export function Banner({ text, action }: { text: string; action?: { label: string; onPress: () => void } }) {
  return (
    <View accessibilityRole="alert" style={s.banner}>
      <Text style={s.bannerText}>{text}</Text>
      {action && <Btn label={action.label} onPress={action.onPress} variant="outline" />}
    </View>
  );
}

/** Alert.alert is a no-op on web, so fall back to window.confirm for the browser preview. */
export function confirm(title: string, message: string, okLabel: string, onOk: () => void) {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}\n\n${message}`)) onOk();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: okLabel, style: 'destructive', onPress: onOk },
  ]);
}

const s = StyleSheet.create({
  btn: { minHeight: 52, minWidth: 48, paddingHorizontal: 20, borderRadius: 8, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 17, fontWeight: '700' },
  banner: { marginHorizontal: 16, marginBottom: 12, padding: 12, borderRadius: 8, backgroundColor: C.surface, borderLeftWidth: 4, borderLeftColor: C.primary, gap: 8 },
  bannerText: { fontSize: 16, color: C.ink, lineHeight: 22 },
});
