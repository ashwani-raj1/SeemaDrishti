import { MCPToolset } from "@google/adk"


export const seemadrishti_mcp = new MCPToolset({ 
     type: "StreamableHTTPConnectionParams",
     url: "http://localhost:13000/mcp",
}) 