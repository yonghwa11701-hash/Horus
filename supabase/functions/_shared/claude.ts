import Anthropic from 'npm:@anthropic-ai/sdk@0.133.0';
import type { z } from 'npm:zod@4.1.12';
import { ApiError, env } from './http.ts';
import { parseModelJson } from './agent-logic.ts';

// Producers run often and must be fast; evaluators and the summary judge quality (CLAUDE.md §6).
export const AGENT_MODEL = Deno.env.get('AGENT_MODEL') ?? 'claude-haiku-5-5';
export const REVIEW_MODEL = Deno.env.get('REVIEW_MODEL') ?? 'claude-sonnet-5-5';

let client: Anthropic | undefined;
const prompts = new Map<string, string>();

// Prompt files ship with each function through `static_files` in supabase/config.toml.
async function systemPrompt(file: string) {
  let text = prompts.get(file);
  if (!text) {
    text = await Deno.readTextFile(new URL(`./prompts/${file}`, import.meta.url));
    prompts.set(file, text);
  }
  return text;
}

// One agent call: prompt file as system, JSON input as the user turn, JSON object back.
// A malformed reply is re-requested once; HTTP errors are retried by the SDK. `signal` aborts at the caller's deadline.
export async function callAgent<T>(
  file: string, model: string, input: unknown, schema: z.ZodType<T>, signal?: AbortSignal,
): Promise<T> {
  client ??= new Anthropic({ apiKey: env('ANTHROPIC_API_KEY'), timeout: 60_000, maxRetries: 2 });
  const system = await systemPrompt(file);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify(input) }],
      output_config: { effort: 'medium' },
      // Sonnet 5.5 safeguards can decline medical text; let the API reroute instead of failing.
      ...(model.startsWith('claude-sonnet-5-5') ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    } as Anthropic.Beta.MessageCreateParamsNonStreaming, { signal });
    if (response.stop_reason === 'refusal') throw new ApiError(502, 'agent_refused', 'An agent declined the request');
    const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    try {
      const parsed = schema.safeParse(parseModelJson(text));
      if (parsed.success) return parsed.data;
    } catch { /* invalid JSON: ask again */ }
  }
  throw new ApiError(502, 'agent_invalid_output', `${file} returned invalid JSON twice`);
}
