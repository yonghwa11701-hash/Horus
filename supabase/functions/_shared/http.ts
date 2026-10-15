import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.117.3';
import { z } from 'npm:zod@4.1.12';
import type { Database } from '../../../src/types/database.ts';
import { validationMessage } from './validation-errors.ts';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export type RequestContext = {
  db: SupabaseClient<Database>;
  userId: string;
  authorization: string;
  traceId: string;
};

export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new ApiError(503, 'configuration_missing', 'A required server setting is missing');
  return value;
}

export function adminClient(): SupabaseClient<Database> {
  return createClient<Database>(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function authenticate(req: Request, traceId: string): Promise<RequestContext> {
  const authorization = req.headers.get('authorization') ?? '';
  if (!/^Bearer \S+$/i.test(authorization)) {
    throw new ApiError(401, 'unauthenticated', 'A valid Supabase session is required');
  }
  const db = createClient<Database>(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // Auth server verifies signature, issuer, expiry and the user; never decode-and-trust.
  const { data, error } = await db.auth.getUser(authorization.slice(7));
  if (error || !data.user) throw new ApiError(401, 'unauthenticated', 'A valid Supabase session is required');
  return { db, userId: data.user.id, authorization, traceId };
}

export function databaseError(error: { code?: string; message: string }): never {
  if (error.code?.match(/^PT(401|404|409|422|429)$/)) {
    throw new ApiError(Number(error.code.slice(2)), error.code, error.message);
  }
  if (error.code === '23505') throw new ApiError(409, 'conflict', 'This identifier or sequence is already in use');
  if (error.code === '23514' || error.code === '22P02') {
    throw new ApiError(422, 'invalid_input', 'The submitted data violates a constraint');
  }
  // No SQL details or transcript text in responses/logs.
  throw new ApiError(503, 'database_unavailable', 'The data operation could not be completed');
}

async function readJson(req: Request): Promise<unknown> {
  if (!req.headers.get('content-type')?.includes('application/json')) {
    throw new ApiError(415, 'unsupported_media_type', 'Use application/json');
  }
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, 'invalid_json', 'A JSON body is required');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) {
      await reader.cancel();
      throw new ApiError(413, 'request_too_large', 'Request body must be at most 64 KiB');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(body)); }
  catch { throw new ApiError(400, 'invalid_json', 'A valid JSON body is required'); }
}

export function serve<T>(schema: z.ZodType<T>, handler: (body: T, context: RequestContext) => Promise<unknown>) {
  Deno.serve(async (req) => {
    const traceId = crypto.randomUUID();
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json;version=1',
      'X-Content-Type-Options': 'nosniff',
      'X-Request-Id': traceId,
      'Vary': 'Origin',
    });
    try {
      const origin = req.headers.get('origin');
      const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? 'http://localhost:8081,http://localhost:19006')
        .split(',').map((value) => value.trim()).filter(Boolean);
      if (origin) {
        if (!allowed.includes(origin)) throw new ApiError(403, 'origin_not_allowed', 'This browser origin is not allowed');
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info, accept');
        headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
        headers.set('Access-Control-Expose-Headers', 'x-request-id, retry-after');
      }
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (req.method !== 'POST') {
        headers.set('Allow', 'POST, OPTIONS');
        throw new ApiError(405, 'method_not_allowed', 'Use POST');
      }
      const accept = req.headers.get('accept') ?? '*/*';
      if (/version\s*=/.test(accept) && !/version\s*=\s*1(?:\D|$)/.test(accept)) {
        throw new ApiError(406, 'unsupported_version', 'Use Accept: application/json;version=1');
      }
      const context = await authenticate(req, traceId);
      const parsed = schema.safeParse(await readJson(req));
      if (!parsed.success) throw new ApiError(422, 'invalid_input', validationMessage(parsed.error.issues));
      return new Response(JSON.stringify(await handler(parsed.data, context)), { status: 200, headers });
    } catch (error) {
      const problem = error instanceof ApiError ? error : new ApiError(500, 'internal_error', 'An unexpected error occurred');
      if (problem.status >= 500) console.error(JSON.stringify({ trace_id: traceId, code: problem.code }));
      if (problem.status === 401) headers.set('WWW-Authenticate', 'Bearer');
      if (problem.status === 429) headers.set('Retry-After', '60');
      headers.set('Content-Type', 'application/problem+json');
      return new Response(JSON.stringify({
        type: 'about:blank', title: problem.code, status: problem.status, detail: problem.message,
        instance: new URL(req.url).pathname, code: problem.code, trace_id: traceId,
      }), { status: problem.status, headers });
    }
  });
}
