package tools

import (
	"context"
	"mcp/internals/backend"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

type IncidentTools struct {
	api *backend.Client
}

func RegisterIncidentTools(api *backend.Client, s *server.MCPServer) {
	t := &IncidentTools{
		api: api,
	}

	s.AddTool(mcp.NewTool(
		"get_incidents",
		mcp.WithDescription("Fetch incidents from the backend"),
		mcp.WithString("incident_id",
			mcp.Required(),
			mcp.Description("The ID of the incident to fetch"),
		)), t.handleGetIncidents)
}

func (t *IncidentTools) handleGetIncidents(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return mcp.NewToolResultText("not implemented"), nil
}
