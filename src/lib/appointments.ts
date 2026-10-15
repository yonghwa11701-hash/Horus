import AsyncStorage from '@react-native-async-storage/async-storage';

import { loadSummary } from '@/lib/consultations';
import { ensureAnonymousSession, getSupabase } from '@/lib/supabase';
import type { TranscriptSegment } from '@/types/consultation';

export type Appointment = { id: string; at: Date; headline?: string };

/** Device copy of a finished appointment, so history survives reloads and new (anonymous) sign-ins. */
export type SavedAppointment = { id: string; at: string; headline?: string; summary: unknown; segments: TranscriptSegment[] };

const STORAGE_KEY = 'horus.appointments.v1';
const MAX_SAVED = 50;

async function readSaved(): Promise<SavedAppointment[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(STORAGE_KEY)) ?? '[]');
  } catch {
    return [];
  }
}

export async function saveAppointment(a: SavedAppointment) {
  const rest = (await readSaved()).filter((x) => x.id !== a.id);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([a, ...rest].slice(0, MAX_SAVED)));
}

export async function loadSavedAppointment(id: string) {
  return (await readSaved()).find((x) => x.id === id) ?? null;
}

export async function removeSavedAppointment(id: string) {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify((await readSaved()).filter((x) => x.id !== id)));
}

const headlineOf = (summary: unknown) => (summary as { headline?: string } | null)?.headline;

/** Completed consultations from this device and the cloud (RLS: current user only), newest first. */
export async function loadAppointments(limit: number): Promise<Appointment[]> {
  const saved = await readSaved();
  const byId = new Map<string, Appointment>(saved.map((a) => [a.id, { id: a.id, at: new Date(a.at), headline: a.headline }]));

  try {
    await ensureAnonymousSession();
    const { data, error } = await getSupabase().from('sessions').select('id, ended_at, updated_at')
      .eq('status', 'completed').order('updated_at', { ascending: false }).limit(limit);
    if (error) throw error;
    // ponytail: one summary download per cloud-only row; fine at demo scale.
    const cloudOnly = await Promise.all(data.filter((row) => !byId.has(row.id)).map(async (row) => ({
      id: row.id,
      at: new Date(row.ended_at ?? row.updated_at),
      headline: await loadSummary(row.id).then((e) => headlineOf(e.payload), () => undefined),
    })));
    cloudOnly.forEach((a) => byId.set(a.id, a));
  } catch {
    // Offline or signed in as a new anonymous user: the device copies still show.
  }

  return [...byId.values()].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
