package tools

import (
	"context"
	"encoding/json"
	"mcp/internals/backend"
	"net/url"
	"strconv"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// defaultDetectionLimit caps list_plate_detections when the caller sets no
// limit. The backend returns every row when none is sent.
const defaultDetectionLimit = 20

type WatchlistTools struct {
	api *backend.Client
}

func RegisterWatchlistTools(api *backend.Client, s *server.MCPServer) {
	t := &WatchlistTools{
		api: api,
	}

	// ------------------------------------------------------------ watchlist entries

	s.AddTool(mcp.NewTool(
		"list_watchlist",
		mcp.WithDescription("List flagged vehicles on the plate watchlist, most severe first: plate, vehicle type, make/model, colour, severity, why it was flagged, notes, and whether the entry is active."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("search", mcp.Description("Substring matched against plate, make/model, flag reason and notes")),
		mcp.WithString("severity",
			mcp.Description("Only entries of this severity"),
			mcp.Enum("INFO", "WARNING", "CRITICAL"),
		),
		mcp.WithString("active",
			mcp.Description("\"true\" returns only active entries; omit for all"),
			mcp.Enum("true"),
		),
		mcp.WithNumber("limit", mcp.Description("Maximum entries to return (all when omitted)")),
		mcp.WithNumber("offset", mcp.Description("Entries to skip, with limit")),
	), t.handleListWatchlist)

	s.AddTool(mcp.NewTool(
		"get_watchlist_entry",
		mcp.WithDescription("Fetch one watchlist entry: the flagged plate and everything recorded about why."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("entry_id", mcp.Required(), mcp.Description("The ID of the watchlist entry")),
	), t.handleGetWatchlistEntry)

	s.AddTool(mcp.NewTool(
		"get_watchlist_stats",
		mcp.WithDescription("Watchlist and ANPR summary: total and active entries, critical and warning counts, plates scanned and watchlist matches in the last 24h, and the plate read rate."),
		mcp.WithReadOnlyHintAnnotation(true),
	), t.handleGetWatchlistStats)

	// ------------------------------------------------------------ plate detections

	s.AddTool(mcp.NewTool(
		"list_plate_detections",
		mcp.WithDescription("Search ANPR plate reads, newest first: plate, vehicle type, camera and zone, detection and plate confidence, whether it matched the watchlist (with the matched entry), severity and boxes. Snapshot images are left out. Simulated reads are never included. Reading also applies the backend's retention purge of reads older than the retention window."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("match_status",
			mcp.Description("Only reads with this outcome"),
			mcp.Enum("CLEAR", "MATCHED"),
		),
		mcp.WithString("camera_id", mcp.Description("Only reads from this camera")),
		mcp.WithString("plate", mcp.Description("Plate substring; spaces, dashes and dots are ignored")),
		mcp.WithNumber("limit", mcp.Description("Maximum reads to return (default 20)")),
		mcp.WithNumber("offset", mcp.Description("Reads to skip")),
	), t.handleListPlateDetections)

	s.AddTool(mcp.NewTool(
		"get_vehicle_traffic",
		mcp.WithDescription("Daily count of every vehicle seen over the last N days, with totals by camera and by vehicle type. Counts all vehicles, not only those whose plate was read."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithNumber("days", mcp.Description("How many days back (backend default 14)")),
		mcp.WithString("camera_id", mcp.Description("Only reads from this camera")),
	), t.handleGetVehicleTraffic)
}

func (t *WatchlistTools) handleListWatchlist(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	q := queryFrom(req, "search", "severity", "active")
	setInt(q, req, "limit")
	setInt(q, req, "offset")

	var out json.RawMessage
	err := t.api.Get(ctx, "/api/watchlist", q, &out)
	return result(out, err)
}

func (t *WatchlistTools) handleGetWatchlistEntry(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := req.RequireString("entry_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	var out json.RawMessage
	err = t.api.Get(ctx, "/api/watchlist/"+url.PathEscape(id), nil, &out)
	return result(out, err)
}

func (t *WatchlistTools) handleGetWatchlistStats(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var out json.RawMessage
	err := t.api.Get(ctx, "/api/watchlist/stats", nil, &out)
	return result(out, err)
}

func (t *WatchlistTools) handleListPlateDetections(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	q := queryFrom(req, "match_status", "camera_id", "plate")
	limit := req.GetInt("limit", defaultDetectionLimit)
	if limit <= 0 {
		limit = defaultDetectionLimit
	}
	q.Set("limit", strconv.Itoa(limit))
	setInt(q, req, "offset")

	// Each read carries its frame as inline base64; dropped here so a page of
	// reads is text a model can use rather than megabytes of image data.
	var reads []map[string]json.RawMessage
	if err := t.api.Get(ctx, "/api/watchlist/detections", q, &reads); err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	for _, read := range reads {
		delete(read, "image_snapshot")
	}

	out, err := json.Marshal(reads)
	return result(out, err)
}

func (t *WatchlistTools) handleGetVehicleTraffic(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	q := queryFrom(req, "camera_id")
	setInt(q, req, "days")

	var out json.RawMessage
	err := t.api.Get(ctx, "/api/watchlist/traffic", q, &out)
	return result(out, err)
}
