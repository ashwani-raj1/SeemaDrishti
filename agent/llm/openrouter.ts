import { BaseLlm } from '@google/adk';
import type { BaseLlmConnection, LlmRequest, LlmResponse } from '@google/adk';
import type { Content, Part } from '@google/genai';

// ADK BaseLlm backed by any OpenAI-compatible Chat Completions API (OpenRouter by default).
// Maps ADK/Gemini contents + function declarations <-> chat messages + tool_calls.

export interface OpenRouterLlmOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  fallbackModels?: string[];
  maxRetries?: number;
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

const MAX_INLINE_STRING = 20_000;
const RETRYABLE = new Set([429, 502, 503]);

function retryDelayMs(res: Response, attempt: number): number {
  const retryAfter = Number(res.headers.get('retry-after'));
  if (retryAfter > 0) return Math.min(retryAfter * 1000, 30_000);
  return 1000 * 2 ** attempt + Math.random() * 500;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// OpenRouter puts the upstream provider's real reason in error.metadata.
function describeError(data: any, status: number): string {
  const err = data?.error;
  if (!err) return `HTTP ${status}`;
  const meta = err.metadata ?? {};
  const provider = meta.provider_name ? ` [${meta.provider_name}]` : '';
  const raw = typeof meta.raw === 'string' ? meta.raw : meta.raw ? JSON.stringify(meta.raw) : '';
  return `${err.message}${provider}${raw ? `: ${raw.slice(0, 500)}` : ''}`;
}

export class OpenRouterLlm extends BaseLlm {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  private readonly fallbackModels: string[];
  private readonly maxRetries: number;

  constructor({ model, apiKey, baseUrl, headers = {}, fallbackModels = [], maxRetries = 3 }: OpenRouterLlmOptions) {
    super({ model });
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.headers = headers;
    this.fallbackModels = fallbackModels;
    this.maxRetries = maxRetries;
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const config = llmRequest.config ?? {};
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toMessages(systemText(config.systemInstruction), llmRequest.contents),
    };
    const tools = toTools(config.tools);
    if (tools.length) body.tools = tools;
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (config.maxOutputTokens !== undefined) body.max_tokens = config.maxOutputTokens;

    // OpenRouter tries these in order when the primary model is rate-limited or down.
    if (this.fallbackModels.length) body.models = [this.model, ...this.fallbackModels];

    let data: any;
    let status = 0;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            ...this.headers,
          },
          body: JSON.stringify(body),
          signal: abortSignal,
        });
      } catch (err) {
        yield { errorCode: 'NETWORK_ERROR', errorMessage: String(err) };
        return;
      }
      status = res.status;
      data = await res.json().catch(() => ({}));

      const code = Number(data.error?.code ?? (res.ok ? 0 : res.status));
      if (!RETRYABLE.has(code) || attempt >= this.maxRetries) break;
      await sleep(retryDelayMs(res, attempt), abortSignal);
    }

    if (status >= 400 || data.error) {
      yield { errorCode: String(data.error?.code ?? status), errorMessage: describeError(data, status) };
      return;
    }

    const message = data.choices?.[0]?.message ?? {};
    const parts: Part[] = [];
    if (message.content) parts.push({ text: message.content });
    for (const call of (message.tool_calls ?? []) as ToolCall[]) {
      parts.push({
        functionCall: { id: call.id, name: call.function.name, args: parseArgs(call.function.arguments) },
      });
    }

    yield {
      content: { role: 'model', parts },
      turnComplete: true,
      usageMetadata: data.usage && {
        promptTokenCount: data.usage.prompt_tokens,
        candidatesTokenCount: data.usage.completion_tokens,
        totalTokenCount: data.usage.total_tokens,
      },
    };
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connections are not supported by OpenRouterLlm.');
  }
}

function systemText(instruction: unknown): string {
  if (!instruction) return '';
  if (typeof instruction === 'string') return instruction;
  if (Array.isArray(instruction)) return instruction.map(systemText).join('\n');
  const content = instruction as Content & Part;
  if (content.parts) return content.parts.map((p) => p.text ?? '').join('\n');
  return content.text ?? '';
}

function toMessages(system: string, contents: Content[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (system) messages.push({ role: 'system', content: system });

  for (const content of contents) {
    const parts = content.parts ?? [];
    const text = parts.map((p) => p.text ?? '').filter(Boolean).join('\n');

    if (content.role === 'model') {
      const toolCalls: ToolCall[] = parts
        .filter((p) => p.functionCall)
        .map((p, i) => ({
          id: p.functionCall!.id ?? `call_${p.functionCall!.name}_${i}`,
          type: 'function',
          function: { name: p.functionCall!.name ?? '', arguments: JSON.stringify(p.functionCall!.args ?? {}) },
        }));
      if (text || toolCalls.length) {
        messages.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      }
      continue;
    }

    // user-role content: function responses become tool messages, text stays user text
    parts.forEach((p, i) => {
      if (!p.functionResponse) return;
      messages.push({
        role: 'tool',
        tool_call_id: p.functionResponse.id ?? `call_${p.functionResponse.name}_${i}`,
        content: JSON.stringify(stripBinary(p.functionResponse.response ?? {})),
      });
    });
    if (text) messages.push({ role: 'user', content: text });
  }
  return messages;
}

function toTools(tools: unknown[] | undefined) {
  const out: { type: 'function'; function: { name: string; description?: string; parameters: unknown } }[] = [];
  for (const tool of (tools ?? []) as any[]) {
    for (const decl of tool.functionDeclarations ?? []) {
      out.push({
        type: 'function',
        function: {
          name: decl.name,
          description: decl.description,
          parameters: decl.parametersJsonSchema ?? toJsonSchema(decl.parameters) ?? { type: 'object', properties: {} },
        },
      });
    }
  }
  return out;
}

// Gemini schemas use upper-case enum types (STRING, OBJECT); JSON Schema wants lower-case.
function toJsonSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (value === undefined || value === null) continue;
    if (key === 'type' && typeof value === 'string') out.type = value.toLowerCase();
    else if (key === 'properties') {
      out.properties = Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, toJsonSchema(v)]));
    } else if (key === 'nullable') {
      continue;
    } else out[key] = toJsonSchema(value);
  }
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

// MCP image results (get_clip_frame) carry base64 JPEGs; keep them out of the text context.
function stripBinary(value: any): any {
  if (typeof value === 'string') {
    return value.length > MAX_INLINE_STRING && /^[A-Za-z0-9+/=\s]+$/.test(value.slice(0, 1000))
      ? `[binary data omitted: ${value.length} chars]`
      : value;
  }
  if (Array.isArray(value)) return value.map(stripBinary);
  if (value && typeof value === 'object') {
    if (value.type === 'image' && typeof value.data === 'string') {
      return { type: 'image', mimeType: value.mimeType, data: `[image omitted: ${value.mimeType ?? 'image'}]` };
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripBinary(v)]));
  }
  return value;
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
