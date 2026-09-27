package tools

import (
	"context"
	"encoding/json"
	"mcp/internals/backend"
	"net/url"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

type CameraTools struct {
	api *backend.Client
}

func RegisterCameraTools(api *backend.Client, s *server.MCPServer) {
	t := &CameraTools{
		api: api,
	}

	s.AddTool(mcp.NewTool(
		"list_cameras",
		mcp.WithDescription("List every camera at the site with its health status, whether it is enabled, the zones it watches, and its open/total incident counts."),
		mcp.WithReadOnlyHintAnnotation(true),
	), t.handleListCameras)

	s.AddTool(mcp.NewTool(
		"get_camera",
		mcp.WithDescription("Fetch one camera: status, enabled, the zones it watches, sibling cameras watching the same zones, and incident counts."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("camera_id", mcp.Required(), mcp.Description("The ID of the camera to fetch")),
	), t.handleGetCamera)

	s.AddTool(mcp.NewTool(
		"get_camera_incidents",
		mcp.WithDescription("Fetch everything that happened on one camera's feed: its incidents and its 50 most recent events."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("camera_id", mcp.Required(), mcp.Description("The camera")),
		mcp.WithString("status",
			mcp.Description("Only incidents in this state"),
			mcp.Enum("OPEN", "ACKNOWLEDGED", "ESCALATED", "DISMISSED"),
		),
		mcp.WithNumber("limit", mcp.Description("Maximum incidents to return (backend default 100)")),
	), t.handleGetCameraIncidents)

	s.AddTool(mcp.NewTool(
		"list_media_cameras",
		mcp.WithDescription("Ask the media hub what it is serving right now, joined with the node's cameras: whether each feed is live, since when, resolution and codec, and whether it is known to the node. Reports the hub as unreachable rather than failing."),
		mcp.WithReadOnlyHintAnnotation(true),
	), t.handleListMediaCameras)
}

func (t *CameraTools) handleListCameras(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var out json.RawMessage
	err := t.api.Get(ctx, "/api/cameras", nil, &out)
	return result(out, err)
}

func (t *CameraTools) handleGetCamera(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := req.RequireString("camera_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	var out json.RawMessage
	err = t.api.Get(ctx, "/api/cameras/"+url.PathEscape(id), nil, &out)
	return result(out, err)
}

func (t *CameraTools) handleGetCameraIncidents(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := req.RequireString("camera_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	q := queryFrom(req, "status")
	setInt(q, req, "limit")

	var out json.RawMessage
	err = t.api.Get(ctx, "/api/cameras/"+url.PathEscape(id)+"/incidents", q, &out)
	return result(out, err)
}

func (t *CameraTools) handleListMediaCameras(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var out json.RawMessage
	err := t.api.Get(ctx, "/api/media/cameras", nil, &out)
	return result(out, err)
}
