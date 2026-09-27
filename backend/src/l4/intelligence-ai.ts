import { env } from "../core/env";
import {
  evidenceKind,
  executeTool,
  redactForModel,
  toolDeclarations,
  type EvidenceRecord,
} from "./intelligence-tools";

const MAX_TOOL_TURNS = 5;

/**
 * What the operator is allowed to see.
 *
 * The model picks tools, but the tools are an implementation detail. An
 * operator reading "Executed: search_vehicle()" learns nothing about their
 * border and everything about our code, so the instruction forbids it outright
 * rather than relying on the UI to filter it afterwards.
 */
const SYSTEM_INSTRUCTION = [
  "You are the global intelligence layer assistant for the IBVAP border-surveillance post at Attari.",
  "Answer the operator's question strictly using the real surveillance logs returned by your tools.",
  "NEVER generate fake events, fake incidents, fake vehicle colors, fake timestamps, fake camera locations, or sample data.",
  "NEVER answer from your own pre-trained knowledge or speculate about unrecorded facts.",
  "If two records happen around the same time or place, do NOT invent a correlation unless explicitly linked by incidentId or plateNumber. Keep them as separate records.",
  "If no matching records exist in the logs for a query, output exactly: 'No recorded events were found for that time and zone.'",
  "Refer to cameras and zones by their human names.",
  "Write concise, operational responses based strictly on the returned structured data.",
  "",
  "STRICT PRESENTATION RULES:",
  "- Never mention tools, function names, tool calls, APIs, endpoints, URLs, JSON, SQL, tables, columns or the database.",
  "- Never narrate your process. No 'I will now search', no 'let me check the records'.",
  "- Never paste raw structured data. Write the conclusion in prose.",
  "- Be concise and operational: what was found, where, and when.",
  "- Markdown is allowed: **bold** and short bullet lists. Nothing else.",
].join("\n");

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

async function callGemini(model: string, apiKey: string, contents: GeminiContent[]) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        tools: [{ functionDeclarations: toolDeclarations() }],
        contents,
        generationConfig: { temperature: 0.1, maxOutputTokens: 700 },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GenAI request failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  return (await response.json()) as { candidates?: GeminiCandidate[] };
}

const textOf = (candidate?: GeminiCandidate) =>
  candidate?.content?.parts?.map((part) => part.text ?? "").join("").trim() ?? "";

export interface IntelligenceAskResult {
  answer: string;
  /** Full, unredacted tool output -- this is what the evidence panel renders. */
  evidence: EvidenceRecord[];
}

/**
 * Ask the model, letting it drive the tool registry.
 *
 * The loop is the whole point: the model may need to list cameras before it can
 * resolve "the north fence camera", or read one incident after finding several.
 * Each call it asks for runs here, against the same L3 functions the REST API
 * uses, and only a redacted, size-capped view goes back into its context.
 *
 * Throws if GenAI is not configured or fails -- the caller decides what the
 * operator sees instead. Nothing here ever returns a fabricated answer.
 */
export async function askIntelligence(question: string): Promise<IntelligenceAskResult> {
  const apiKey = env("GEMINI_API_KEY") || env("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GenAI is not configured on this edge node");

  const model = env("GEMINI_INTELLIGENCE_MODEL", "gemini-2.5-flash-lite");
  const evidence: EvidenceRecord[] = [];

  const contents: GeminiContent[] = [{ role: "user", parts: [{ text: question }] }];

  for (let turn = 0; turn <= MAX_TOOL_TURNS; turn++) {
    const payload = await callGemini(model, apiKey, contents);
    const candidate = payload.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const calls = parts.filter((part) => part.functionCall);

    if (calls.length === 0) {
      const answer = textOf(candidate);
      if (!answer) throw new Error("GenAI returned no answer");
      return { answer, evidence };
    }

    contents.push({ role: "model", parts });

    const responses: GeminiPart[] = [];
    for (const call of calls) {
      const name = call.functionCall!.name;
      const args = call.functionCall!.args ?? {};
      let result: unknown;
      try {
        result = executeTool(name, args);
      } catch (cause) {
        // A bad tool name or a failed query is reported to the model as data,
        // not thrown: it can recover, choose another tool, or say it found
        // nothing. Taking the whole request down would be worse for the
        // operator than a slightly less complete answer.
        result = { error: cause instanceof Error ? cause.message : "tool failed" };
      }

      evidence.push({ kind: evidenceKind(name), args, result });
      responses.push({
        functionResponse: {
          name,
          response: { result: redactForModel(result) ?? null },
        },
      });
    }

    contents.push({ role: "user", parts: responses });
  }

  throw new Error("GenAI exceeded the tool-call budget without answering");
}
