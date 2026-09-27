import 'dotenv/config';
import { LlmAgent } from '@google/adk';
import { OpenRouterLlm } from './llm/openrouter';
import { buildInstructions } from './skills/instructions';
import { seemadrishti_mcp } from "./mcp/index"


const model = process.env.LLM_MODEL_STRING;       // OpenRouter model slug, e.g. anthropic/claude-sonnet-5
const baseUrl = process.env.LLM_BASEURL || 'https://openrouter.ai/api/v1';
const apiKey = process.env.LLM_API_KEY;

if (!model || !apiKey) {
  throw new Error('LLM_MODEL_STRING and LLM_API_KEY must be set (see .env.sample)');
}

const fallbackModels = (process.env.LLM_FALLBACK_MODELS || '').split(',').map((m) => m.trim()).filter(Boolean);

const llm = new OpenRouterLlm({ model, baseUrl, apiKey, fallbackModels });

export const rootAgent = new LlmAgent({
  name: 'investigation_agent',
  description: 'Investigates SeemaDrishti cameras, zones, events and incidents via the SeemaDrishti MCP.',
  instruction: buildInstructions,
  model: llm,
  tools: [seemadrishti_mcp],
  generateContentConfig: { temperature: 0.2 },
});
