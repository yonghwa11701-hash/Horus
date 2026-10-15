// Runs the agent prompts in supabase/functions/_shared/prompts through the full
// producer -> evaluator -> retry pipeline for each scenario, then applies hard asserts.
// Usage: node supabase/tests/prompts/run.mjs [scenario-name ...]   (MODEL=sonnet by default)
// shortcut: calls the model through `claude -p` (no API key in this repo); switch to the Claude API once the edge functions exist.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scenarios } from "./scenarios.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS = path.resolve(dir, "../../functions/_shared/prompts");
const MODEL = process.env.MODEL || "sonnet";
const MAX_RETRIES = 2;

function callModel(promptFile, input) {
  return new Promise((resolve, reject) => {
    const p = spawn("claude", ["-p", "--system-prompt-file", path.join(PROMPTS, promptFile), "--tools", "",
      "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--model", MODEL,
      "--output-format", "json"]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${promptFile} exited ${code}: ${err || out}`));
      const text = JSON.parse(out).result.trim();
      // The prompts say "return only JSON"; tolerate a code fence but record that it happened.
      const m = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
      try { resolve({ json: JSON.parse(m ? m[1] : text), fenced: !!m }); }
      catch { reject(new Error(`${promptFile} returned non-JSON:\n${text}`)); }
    });
    p.stdin.end(JSON.stringify(input));
  });
}

// Spec retry rule: up to 2 retries with evaluator feedback; else keep the best score and flag it.
async function produce(name, producerFile, evaluatorFile, input, evalInput, log) {
  const attempts = [];
  let feedback = null;
  for (let i = 0; i <= MAX_RETRIES; i++) {
    const out = await callModel(producerFile, { ...input, evaluator_feedback: feedback });
    const ev = await callModel(evaluatorFile, { ...evalInput, output: out.json });
    attempts.push({ output: out.json, fenced: out.fenced, eval: ev.json });
    log(`  ${name} attempt ${i + 1}: pass=${ev.json.pass} score=${ev.json.score}` +
      (ev.json.pass ? "" : ` issues=${JSON.stringify(ev.json.issues?.map((x) => `${x.check}@${x.location}: ${x.problem}`))}`));
    if (ev.json.pass) return { ...attempts.at(-1), attempts: attempts.length, flagged: false };
    feedback = ev.json.feedback;
  }
  const best = attempts.reduce((a, b) => (b.eval.score > a.eval.score ? b : a));
  return { ...best, attempts: attempts.length, flagged: true };
}

async function runScenario(s) {
  const lines = [`== ${s.name}: ${s.description}`];
  const log = (l) => lines.push(l);
  const failures = [];
  const check = (ok, msg) => { if (!ok) failures.push(msg); };

  let state = null;
  let questions = s.questions;
  const results = { understanding: [], questions: [] };
  for (const chunk of s.chunks) {
    const patient_questions = questions.filter((q) => q.status === "unanswered").map(({ id, text, status }) => ({ id, text, status }));
    const u = await produce("understanding", "understanding.md", "understanding-evaluator.md",
      { prior_state: state, chunk, patient_questions }, { prior_state: state, chunk, patient_questions }, log);
    results.understanding.push(u);
    state = u.output;

    const q = await produce("questions", "question-generation.md", "question-evaluator.md",
      { understanding: state, questions }, { understanding: state, questions_before: questions }, log);
    results.questions.push(q);
    // Spec: server assigns final ids to new-N questions.
    let n = questions.length;
    questions = q.output.questions.map((x) => (String(x.id).startsWith("new-") ? { ...x, id: `q${++n}` } : x));
  }

  const transcript = s.chunks.join("\n");
  const summary = await produce("summary", "summary.md", "summary-evaluator.md",
    { transcript, understanding: state, questions }, { transcript, understanding: state, questions }, log);

  // Generic asserts for every scenario.
  for (const [stage, rs] of Object.entries({ ...results, summary: [summary] }))
    rs.forEach((r, i) => {
      check(!r.flagged, `${stage}[${i}] never passed its evaluator (best score ${r.eval.score})`);
      if (r.fenced) log(`  warn: ${stage}[${i}] wrapped JSON in a code fence despite "return only JSON"`);
    });
  for (const qp of s.questions.filter((x) => x.source === "patient"))
    check(questions.some((x) => x.text === qp.text), `patient question lost or rewritten: "${qp.text}"`);
  results.questions.forEach((r, i) => {
    const newOnes = r.output.questions.filter((x) => String(x.id).startsWith("new-"));
    check(newOnes.length <= 3, `questions[${i}] added ${newOnes.length} new questions (max 3)`);
    for (const x of r.output.questions.filter((q) => q.source === "ai"))
      check(x.text.split(/\s+/).length <= 20, `question over 20 words: "${x.text}"`);
  });
  // Required-content sections (important, next_steps, medications) may exceed 5 by design.
  for (const k of ["what_the_doctor_found"])
    check((summary.output[k] ?? []).length <= 5, `summary.${k} has more than 5 bullets`);
  for (const k of ["headline", "important", "what_the_doctor_found", "medications", "next_steps", "answered_questions", "still_to_ask", "unclear"])
    check(k in summary.output, `summary missing key ${k}`);

  // Scenario-specific asserts.
  s.expect?.({ state, questions, summary: summary.output, check });

  log(failures.length ? `  FAIL\n${failures.map((f) => "   - " + f).join("\n")}` : "  PASS");
  return { name: s.name, failures, lines, state, questions, summary: summary.output };
}

const only = process.argv.slice(2);
const unknown = only.filter((n) => !scenarios.some((s) => s.name === n));
if (unknown.length) {
  console.error(`Unknown scenario(s): ${unknown.join(", ")}\nKnown: ${scenarios.map((s) => s.name).join(", ")}`);
  process.exit(2);
}
const picked = only.length ? scenarios.filter((s) => only.includes(s.name)) : scenarios;
const settled = await Promise.allSettled(picked.map(runScenario));
let failed = 0;
settled.forEach((r, i) => {
  if (r.status === "rejected") { failed++; console.log(`== ${picked[i].name}\n  ERROR ${r.reason.message}`); return; }
  console.log(r.value.lines.join("\n"));
  if (r.value.failures.length) {
    failed++;
    console.log("  final state:", JSON.stringify({ understanding: r.value.state, questions: r.value.questions, summary: r.value.summary }));
  }
});
console.log(`\n${picked.length - failed}/${picked.length} scenarios passed (model: ${MODEL})`);
process.exit(failed ? 1 : 0);
