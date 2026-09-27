package tools

import (
	"context"
	"encoding/json"
	"mcp/internals/backend"
	"net/url"

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
		"list_incidents",
		mcp.WithDescription("List incidents, newest first. Each incident groups the events of one intrusion on one zone."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("status",
			mcp.Description("Only incidents in this state"),
			mcp.Enum("OPEN", "ACKNOWLEDGED", "ESCALATED", "DISMISSED"),
		),
		mcp.WithString("camera_id", mcp.Description("Only incidents seen by this camera")),
		mcp.WithString("zone_id", mcp.Description("Only incidents on this zone")),
		mcp.WithNumber("limit", mcp.Description("Maximum incidents to return (backend default 100, max 500)")),
	), t.handleListIncidents)

	s.AddTool(mcp.NewTool(
		"get_incident",
		mcp.WithDescription("Fetch one incident with its events, the decisions taken on it, and what other cameras on the same zone saw around the same time."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("incident_id",
			mcp.Required(),
			mcp.Description("The ID of the incident to fetch"),
		),
	), t.handleGetIncident)
}

func (t *IncidentTools) handleListIncidents(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	q := queryFrom(req, "status", "camera_id", "zone_id")
	setInt(q, req, "limit")

	var out json.RawMessage
	err := t.api.Get(ctx, "/api/incidents", q, &out)
	return result(out, err)
}

func (t *IncidentTools) handleGetIncident(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := req.RequireString("incident_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	var out json.RawMessage
	err = t.api.Get(ctx, "/api/incidents/"+url.PathEscape(id), nil, &out)
	return result(out, err)
}
