import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { C } from '@/constants/theme';

SplashScreen.preventAutoHideAsync();

export const unstable_settings = { anchor: 'index' };

// Light only (spec): ignore the system colour scheme.
export default function RootLayout() {
  return (
    <ThemeProvider value={{ ...DefaultTheme, colors: { ...DefaultTheme.colors, background: C.bg } }}>
      <StatusBar style="dark" />
      <AnimatedSplashOverlay />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="session/[id]/index" options={{ gestureEnabled: false }} />
        <Stack.Screen name="session/[id]/ending" options={{ gestureEnabled: false }} />
      </Stack>
    </ThemeProvider>
  );
}
