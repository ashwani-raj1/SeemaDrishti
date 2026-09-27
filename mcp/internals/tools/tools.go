package tools

import (
	"encoding/json"
	"net/url"
	"strconv"

	"github.com/mark3labs/mcp-go/mcp"
)

// queryFrom copies the named string arguments the caller actually set into a
// query string. The keys are the backend's own parameter names, so a tool
// argument and the filter it drives are always spelled the same.
func queryFrom(req mcp.CallToolRequest, keys ...string) url.Values {
	q := url.Values{}
	for _, key := range keys {
		if val := req.GetString(key, ""); val != "" {
			q.Set(key, val)
		}
	}
	return q
}

// setInt adds a numeric argument when the caller set one; zero means "use the
// backend's default".
func setInt(q url.Values, req mcp.CallToolRequest, key string) {
	if val := req.GetInt(key, 0); val > 0 {
		q.Set(key, strconv.Itoa(val))
	}
}

// result relays the backend's answer. A backend refusal is returned as a tool
// error, not a protocol error, so the model sees the message and can react.
func result(raw json.RawMessage, err error) (*mcp.CallToolResult, error) {
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return mcp.NewToolResultText(string(raw)), nil
}
