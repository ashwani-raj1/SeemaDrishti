import 'dotenv/config';
import { MCPToolset } from "@google/adk"

const actor = process.env.IBVAP_ACTOR; // optional, e.g. usr_supervisor; backend defaults to usr_operator

export const seemadrishti_mcp = new MCPToolset({
     type: "StreamableHTTPConnectionParams",
     url: process.env.SEEMADRISHTI_MCP_URL || "http://localhost:13000/mcp",
     ...(actor ? { header: { 'x-ibvap-actor': actor } } : {}),
})
