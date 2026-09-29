package tools

import (
	"context"
	"encoding/json"
	"mcp/internals/backend"
	"net/url"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// The person dossier routes are deliberately not exposed: they are
// supervisor-only and every view writes an audit row, so they stay in the
// console.

type PersonTools struct {
	api *backend.Client
}

func RegisterPersonTools(api *backend.Client, s *server.MCPServer) {
	t := &PersonTools{
		api: api,
	}

	s.AddTool(mcp.NewTool(
		"list_person_watchlist",
		mcp.WithDescription("List people on the person watchlist: name, notes, address, government ID, plates they are recorded as owning, whether they are enrolled for face and appearance matching, and whether the entry is active. Address, government ID and plate ownership are operator-entered mock data, not verified records."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("active",
			mcp.Description("\"true\" returns only active entries; omit for all"),
			mcp.Enum("true"),
		),
	), t.handleListPersonWatchlist)

	s.AddTool(mcp.NewTool(
		"get_person_watchlist_entry",
		mcp.WithDescription("Fetch one person on the watchlist by name."),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithString("name", mcp.Required(), mcp.Description("The person's name as entered on the watchlist")),
	), t.handleGetPersonWatchlistEntry)
}

func (t *PersonTools) handleListPersonWatchlist(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var entries []map[string]json.RawMessage
	if err := t.api.Get(ctx, "/api/watchlist/people", queryFrom(req, "active"), &entries); err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	for _, entry := range entries {
		flagEmbeddings(entry)
	}

	out, err := json.Marshal(entries)
	return result(out, err)
}

func (t *PersonTools) handleGetPersonWatchlistEntry(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	name, err := req.RequireString("name")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	var entry map[string]json.RawMessage
	if err := t.api.Get(ctx, "/api/watchlist/people/"+url.PathEscape(name), nil, &entry); err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	flagEmbeddings(entry)

	out, err := json.Marshal(entry)
	return result(out, err)
}

// flagEmbeddings swaps each embedding vector -- hundreds of floats that mean
// nothing to a model -- for whether the person is enrolled for that signal.
func flagEmbeddings(entry map[string]json.RawMessage) {
	for field, flag := range map[string]string{
		"face_embedding":       "has_face_embedding",
		"appearance_embedding": "has_appearance_embedding",
	} {
		var vector []float64
		_ = json.Unmarshal(entry[field], &vector) // absent or null leaves it empty
		entry[flag], _ = json.Marshal(len(vector) > 0)
		delete(entry, field)
	}
}
