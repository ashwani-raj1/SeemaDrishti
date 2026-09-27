package tools

import (
	"context"
	"encoding/json"
	"mcp/internals/backend"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

type EventTools struct {
	api *backend.Client
}

func RegisterEventTools(api *backend.Client, s *server.MCPServer) {
	t := &EventTools{
		api: api,
	}

	s.AddTool(mcp.NewTool(
		"list_events",
		mcp.WithDescription("Search the event log: every detection the node recorded, alerted on or not, newest first."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("camera_id", mcp.Description("Only events from this camera")),
		mcp.WithString("zone_id", mcp.Description("Only events on this zone")),
		mcp.WithString("severity",
			mcp.Description("Only events of this severity"),
			mcp.Enum("INFO", "WARNING", "CRITICAL"),
		),
		mcp.WithString("class", mcp.Description("Only this detected class, e.g. person or vehicle")),
		mcp.WithString("alertable",
			mcp.Description("\"true\" returns only events that raised an alert; omit for all"),
			mcp.Enum("true"),
		),
		mcp.WithString("since", mcp.Description("ISO-8601 timestamp; events at or after it")),
		mcp.WithString("until", mcp.Description("ISO-8601 timestamp; events at or before it")),
		mcp.WithNumber("after_seq", mcp.Description("Only events with a sequence number above this one")),
		mcp.WithNumber("limit", mcp.Description("Maximum events to return (backend default 200, max 2000)")),
	), t.handleListEvents)
}

func (t *EventTools) handleListEvents(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	q := queryFrom(req, "camera_id", "zone_id", "severity", "class", "alertable", "since", "until")
	setInt(q, req, "after_seq")
	setInt(q, req, "limit")

	var out json.RawMessage
	err := t.api.Get(ctx, "/api/events", q, &out)
	return result(out, err)
}
