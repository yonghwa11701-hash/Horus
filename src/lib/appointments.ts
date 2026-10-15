import { loadSummary } from '@/lib/consultations';
import { ensureAnonymousSession, getSupabase } from '@/lib/supabase';

export type Appointment = { id: string; at: Date; headline?: string };

/** Completed consultations, newest first. RLS (sessions_owner_read) limits them to the current user. */
export async function loadAppointments(limit: number): Promise<Appointment[]> {
  await ensureAnonymousSession();
  const { data, error } = await getSupabase().from('sessions').select('id, ended_at, updated_at')
    .eq('status', 'completed').order('updated_at', { ascending: false }).limit(limit);
  if (error) throw error;
  // ponytail: one summary download per row; fine for a demo-sized list, store headlines on sessions if it grows.
  return Promise.all(data.map(async (row) => ({
    id: row.id,
    at: new Date(row.ended_at ?? row.updated_at),
    headline: await loadSummary(row.id).then((e) => (e.payload as { headline?: string } | null)?.headline, () => undefined),
  })));
}
