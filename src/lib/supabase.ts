import 'react-native-url-polyfill/auto';
import { createClient, processLock, type Session, type SupabaseClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';
import type { Database } from '@/types/database';

let client: SupabaseClient<Database> | undefined;
let signingIn: Promise<Session> | undefined;

export function getSupabase(): SupabaseClient<Database> {
  if (client) return client;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Set the two public Supabase values in Horus/.env first.');
  if (key.startsWith('sb_secret_')) throw new Error('A Supabase secret key must never be used in Expo.');
  client = createClient<Database>(url, key, {
    auth: {
      storage: Platform.OS === 'web' ? {
        // Session-only browser persistence; no bearer tokens in localStorage.
        getItem: (name: string) => typeof window === 'undefined' ? null : window.sessionStorage.getItem(name),
        setItem: (name: string, value: string) => { if (typeof window !== 'undefined') window.sessionStorage.setItem(name, value); },
        removeItem: (name: string) => { if (typeof window !== 'undefined') window.sessionStorage.removeItem(name); },
      } : {
        getItem: SecureStore.getItemAsync,
        setItem: SecureStore.setItemAsync,
        removeItem: SecureStore.deleteItemAsync,
      },
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      ...(Platform.OS !== 'web' ? { lock: processLock } : {}),
    },
  });
  if (Platform.OS !== 'web') {
    const instance = client;
    if (AppState.currentState !== 'active') instance.auth.stopAutoRefresh();
    AppState.addEventListener('change', (state) => {
      if (state === 'active') instance.auth.startAutoRefresh(); else instance.auth.stopAutoRefresh();
    });
  }
  return client;
}

// Single flight prevents parallel screen/voice requests creating separate anonymous identities.
export function ensureAnonymousSession(): Promise<Session> {
  if (signingIn) return signingIn;
  signingIn = (async () => {
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (data.session) return data.session;
    const result = await supabase.auth.signInAnonymously();
    if (result.error) throw result.error;
    if (!result.data.session) throw new Error('Anonymous sign-in did not create a session.');
    return result.data.session;
  })().finally(() => { signingIn = undefined; });
  return signingIn;
}
