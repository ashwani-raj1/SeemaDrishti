import { LlmAgent } from '@google/adk';
import { ModelMux } from 'model-mux';
import { INVESTIGATION_INSTRUCTIONS } from './skills/instructions';
import { seemadrishti_mcp } from "./mcp/index"




const model = process.env.LLM_MODEL_STRING ||  '';       // OpenRouter model slug
const baseUrl =  process.env.LLM_BASEURL || 'https://openrouter.ai/api/v1';
const apiKey = process.env.LLM_API_KEY;



const modelMux = new ModelMux({ model, baseUrl, apiKey });

const agent = new LlmAgent({
  name: 'investigation_agent',
  instruction: INVESTIGATION_INSTRUCTIONS,
  model: modelMux,
//   tools: [...],
});