package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"mcp/internals/backend"
	"net/url"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

type ClipTools struct {
	api *backend.Client
}

// clipFrameMeta is everything about a frame except its pixels.
type clipFrameMeta struct {
	ClipID string          `json:"clipId"`
	Seq    int             `json:"seq"`
	Offset float64         `json:"offset"`
	Boxes  json.RawMessage `json:"boxes"`
}

// clipFrame is GET /api/clips/:clipId/frames/:seq asked for as JSON. The
// backend stores the JPEG as base64 and sends it untouched, which is exactly
// what MCP image content carries.
type clipFrame struct {
	clipFrameMeta
	JPEG string `json:"jpeg"`
}

func RegisterClipTools(api *backend.Client, s *server.MCPServer) {
	t := &ClipTools{
		api: api,
	}

	s.AddTool(mcp.NewTool(
		"get_clip",
		mcp.WithDescription("Fetch an evidence clip's filmstrip: camera, time, real capture fps, and every frame's offset from the crossing (negative before, positive after) with the boxes detected in it. No pixels. An event's clip ID is in its evidence.clipId."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("clip_id", mcp.Required(), mcp.Description("The clip, e.g. from an event's evidence.clipId")),
	), t.handleGetClip)

	s.AddTool(mcp.NewTool(
		"get_clip_frame",
		mcp.WithDescription("Look at one frame of an evidence clip: returns the image itself, plus its offset from the crossing and the boxes detected in it. Use get_clip first to pick a frame, e.g. the one nearest offset 0."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("clip_id", mcp.Required(), mcp.Description("The clip")),
		mcp.WithNumber("seq", mcp.Required(), mcp.Description("Frame number, from 0"), mcp.Min(0)),
	), t.handleGetClipFrame)

	s.AddTool(mcp.NewTool(
		"get_clip_usage",
		mcp.WithDescription("How much clip evidence this node is holding: clip and frame counts, total bytes, and the oldest clip's age."),
		mcp.WithReadOnlyHintAnnotation(true),
	), t.handleGetClipUsage)
}

func (t *ClipTools) handleGetClip(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := req.RequireString("clip_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	var out json.RawMessage
	err = t.api.Get(ctx, "/api/clips/"+url.PathEscape(id), nil, &out)
	return result(out, err)
}

func (t *ClipTools) handleGetClipFrame(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := req.RequireString("clip_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	seq, err := req.RequireInt("seq")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	var frame clipFrame
	path := fmt.Sprintf("/api/clips/%s/frames/%d", url.PathEscape(id), seq)
	if err := t.api.Get(ctx, path, nil, &frame); err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	meta, err := json.Marshal(frame.clipFrameMeta)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return mcp.NewToolResultImage(string(meta), frame.JPEG, "image/jpeg"), nil
}

func (t *ClipTools) handleGetClipUsage(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var out json.RawMessage
	err := t.api.Get(ctx, "/api/clips", nil, &out)
	return result(out, err)
}
