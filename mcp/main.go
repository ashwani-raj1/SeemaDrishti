package main

import (
	"context"
	"log"
	"mcp/internals/backend"
	"mcp/internals/tools"
	"net/http"
	"os"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// Severity tags for the log, coloured with ANSI escapes.
const (
	levelDebug = "\033[36mDBG\033[0m"
	levelInfo  = "\033[32mINF\033[0m"
	levelError = "\033[31mERR\033[0m"
)

func logf(level, format string, args ...any) {
	log.Printf(level+" "+format, args...)
}

func main() {

	logf(levelInfo, "Starting MCP server...")

	baseURL := getVar("BACKEND_URL", "http://localhost:8000")
	addr := getVar("MCP_ADDR", ":13000")

	api := backend.New(baseURL)

	mcpServer := server.NewMCPServer(
		"seemadrishti-mcp",
		"0.1.0",
		server.WithToolCapabilities(true),
		server.WithToolHandlerMiddleware(logCalls),
	)

	tools.RegisterIncidentTools(api, mcpServer)
	tools.RegisterEventTools(api, mcpServer)
	tools.RegisterZoneTools(api, mcpServer)
	tools.RegisterCameraTools(api, mcpServer)
	tools.RegisterClipTools(api, mcpServer)
	tools.RegisterWatchlistTools(api, mcpServer)
	tools.RegisterPersonTools(api, mcpServer)

	httpServer := server.NewStreamableHTTPServer(
		mcpServer,
		server.WithStateLess(true),
		// Pass the caller's actor through to the backend untouched.
		server.WithHTTPContextFunc(func(ctx context.Context, r *http.Request) context.Context {
			return backend.WithActor(ctx, r.Header.Get(backend.ActorHeader))
		}),
	)

	logf(levelInfo, "MCP server listening on %s (backend: %s)", addr, baseURL)

	if err := httpServer.Start(addr); err != nil {
		logf(levelError, "mcp http server: %v", err)
		os.Exit(1)
	}

}

func getVar(key string, fallback string) string {
	logf(levelDebug, "Getting environment variable: %s", key)

	if val := os.Getenv(key); val != "" {
		return val
	}

	logf(levelDebug, "Using fallback value for variable: %s", key)
	return fallback
}

// logCalls wraps every tool handler: one line when it is called, and one when
// it finishes -- ERR if it failed, DBG with the time taken if it did not.
func logCalls(next server.ToolHandlerFunc) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		name := req.Params.Name
		logf(levelInfo, "%s called with %v", name, req.GetArguments())

		start := time.Now()
		res, err := next(ctx, req)

		switch {
		case err != nil:
			logf(levelError, "%s: %v", name, err)
		case res != nil && res.IsError && len(res.Content) > 0:
			logf(levelError, "%s: %s", name, mcp.GetTextFromContent(res.Content[0]))
		default:
			logf(levelDebug, "%s done in %s", name, time.Since(start))
		}
		return res, err
	}
}
