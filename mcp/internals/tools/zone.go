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

type ZoneTools struct {
	api *backend.Client
}

// zoneDetail is the part of GET /api/zones/:id these tools pick apart. The
// backend has no separate route for a zone's cameras or targets; both arrive
// nested in the zone, so they are sliced out here rather than re-fetched.
type zoneDetail struct {
	Targets json.RawMessage   `json:"targets"`
	Cameras []json.RawMessage `json:"cameras"`
}

// zoneCamera is one camera's binding to a zone, as far as these tools read it.
type zoneCamera struct {
	CameraID         string          `json:"cameraId"`
	Overrides        json.RawMessage `json:"overrides"`
	EffectiveTargets json.RawMessage `json:"effectiveTargets"`
}

func RegisterZoneTools(api *backend.Client, s *server.MCPServer) {
	t := &ZoneTools{
		api: api,
	}

	s.AddTool(mcp.NewTool(
		"list_zones",
		mcp.WithDescription("List every zone at the site, oldest first, each with its target policy and the cameras that watch it."),
		mcp.WithReadOnlyHintAnnotation(true),
	), t.handleListZones)

	s.AddTool(mcp.NewTool(
		"get_zone",
		mcp.WithDescription("Fetch one zone: its kind, sector, target policy, and every camera bound to it with that camera's shape and overrides."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("zone_id", mcp.Required(), mcp.Description("The ID of the zone to fetch")),
	), t.handleGetZone)

	s.AddTool(mcp.NewTool(
		"get_zone_camera",
		mcp.WithDescription("Fetch how one camera watches one zone: the shape drawn on its frame, direction, confirm time, whether it is placed and active, its target overrides and the targets that actually apply."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("zone_id", mcp.Required(), mcp.Description("The zone")),
		mcp.WithString("camera_id", mcp.Required(), mcp.Description("A camera bound to that zone")),
	), t.handleGetZoneCamera)

	s.AddTool(mcp.NewTool(
		"get_zone_targets",
		mcp.WithDescription("Fetch what a zone detects, in priority order: each class with its severity and whether it alerts or is only logged. With camera_id, returns that camera's overrides and the targets that actually apply on it."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("zone_id", mcp.Required(), mcp.Description("The zone")),
		mcp.WithString("camera_id", mcp.Description("Resolve the targets for this camera instead of the zone's own policy")),
	), t.handleGetZoneTargets)
}

func (t *ZoneTools) handleListZones(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var out json.RawMessage
	err := t.api.Get(ctx, "/api/zones", nil, &out)
	return result(out, err)
}

func (t *ZoneTools) handleGetZone(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := req.RequireString("zone_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	var out json.RawMessage
	err = t.api.Get(ctx, "/api/zones/"+url.PathEscape(id), nil, &out)
	return result(out, err)
}

func (t *ZoneTools) handleGetZoneCamera(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	zoneID, err := req.RequireString("zone_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	cameraID, err := req.RequireString("camera_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	zone, err := t.zone(ctx, zoneID)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	raw, _, err := zone.camera(zoneID, cameraID)
	return result(raw, err)
}

func (t *ZoneTools) handleGetZoneTargets(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	zoneID, err := req.RequireString("zone_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	zone, err := t.zone(ctx, zoneID)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	cameraID := req.GetString("camera_id", "")
	if cameraID == "" {
		return result(zone.Targets, nil)
	}

	_, cam, err := zone.camera(zoneID, cameraID)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	out, err := json.Marshal(map[string]json.RawMessage{
		"zoneTargets":      zone.Targets,
		"overrides":        cam.Overrides,
		"effectiveTargets": cam.EffectiveTargets,
	})
	return result(out, err)
}

func (t *ZoneTools) zone(ctx context.Context, zoneID string) (*zoneDetail, error) {
	var zone zoneDetail
	if err := t.api.Get(ctx, "/api/zones/"+url.PathEscape(zoneID), nil, &zone); err != nil {
		return nil, err
	}
	return &zone, nil
}

// camera finds one camera's binding, returning it both verbatim and decoded.
func (z *zoneDetail) camera(zoneID, cameraID string) (json.RawMessage, zoneCamera, error) {
	for _, raw := range z.Cameras {
		var cam zoneCamera
		if err := json.Unmarshal(raw, &cam); err != nil {
			return nil, zoneCamera{}, err
		}
		if cam.CameraID == cameraID {
			return raw, cam, nil
		}
	}
	return nil, zoneCamera{}, fmt.Errorf("camera %s is not bound to zone %s", cameraID, zoneID)
}
