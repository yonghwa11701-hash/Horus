import Constants from 'expo-constants';
import { Platform } from 'react-native';
import schema from './debug-schema.json';

let inFlight = 0;
let retryAfter = 0;
let warned = false;

function terminalUrl(): string | null {
  if (Platform.OS === 'web') return typeof window === 'undefined' ? null : `${window.location.origin}/__horus/voice-debug`;
  const host = Constants.expoConfig?.hostUri;
  if (!host) return null;
  const address = host.includes('://') ? host.replace(/^exp:/, 'http:').replace(/^exps:/, 'https:')
    : `${host.includes('.exp.direct') ? 'https' : 'http'}://${host}`;
  try { return new URL('/__horus/voice-debug', address).toString(); }
  catch { return null; }
}

// Diagnostics only: no transcript/audio/user/session identifiers, credentials, raw
// errors or request/response bodies. The terminal endpoint applies the same allowlist.
export function voiceDebug(kind: string, fields: Record<string, unknown> = {}) {
  if (!__DEV__ || !schema.events.includes(kind)) return;
  const safe: Record<string, string | number | boolean> = { kind, platform: Platform.OS };
  for (const key of schema.numbers) {
    const value = fields[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12) safe[key] = value;
  }
  for (const key of schema.booleans) {
    const value = fields[key];
    if (typeof value === 'boolean') safe[key] = value;
  }
  for (const [key, values] of Object.entries(schema.strings)) {
    const value = fields[key];
    if (typeof value === 'string' && values.includes(value)) safe[key] = value;
  }
  if (typeof fields.last_event === 'string' && /^[a-z_]{1,64}$/.test(fields.last_event)) safe.last_event = fields.last_event;
  const body = JSON.stringify(safe);
  console.info(`[horus:voice/client] ${body}`);
  const url = terminalUrl();
  if (!url || inFlight >= 4 || Date.now() < retryAfter) return;
  inFlight++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  void fetch(url, {
    method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal,
  }).then(async (response) => {
    await response.body?.cancel();
    if (response.status !== 204) throw new Error('Debug endpoint unavailable');
  }).catch(() => {
    retryAfter = Date.now() + 5000;
    if (!warned) {
      warned = true;
      console.warn('[horus:voice] Terminal forwarding unavailable. Restart Expo after updating metro.config.js; client logs remain available.');
    }
  }).finally(() => { clearTimeout(timer); inFlight--; });
}
