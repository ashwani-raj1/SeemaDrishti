package main

import (
	"context"
	"log"
	"mcp/internals/backend"
	"mcp/internals/tools"
	"net/http"
	"os"

	"github.com/mark3labs/mcp-go/server"
)

func main() {

	log.Println("Starting MCP server...")

	baseURL := getVar("BACKEND_URL", "http://localhost:8000")
	addr := getVar("MCP_ADDR", ":13000")

	api := backend.New(baseURL)

	mcpServer := server.NewMCPServer(
		"seemadrishti-mcp",
		"0.1.0",
		server.WithToolCapabilities(true),
	)

	tools.RegisterIncidentTools(api, mcpServer)
	tools.RegisterEventTools(api, mcpServer)
	tools.RegisterZoneTools(api, mcpServer)
	tools.RegisterCameraTools(api, mcpServer)
	tools.RegisterClipTools(api, mcpServer)

	httpServer := server.NewStreamableHTTPServer(
		mcpServer,
		server.WithStateLess(true),
		// Pass the caller's actor through to the backend untouched.
		server.WithHTTPContextFunc(func(ctx context.Context, r *http.Request) context.Context {
			return backend.WithActor(ctx, r.Header.Get(backend.ActorHeader))
		}),
	)

	log.Printf("MCP server listening on %s (backend: %s)", addr, baseURL)

	if err := httpServer.Start(addr); err != nil {
		log.Fatalf("mcp http server: %v", err)
	}

}

func getVar(key string, fallback string) string {
	log.Printf("Getting environment variable: %s", key)

	if val := os.Getenv(key); val != "" {
		return val
	}

	log.Printf("Using fallback value for variable: %s", key)
	return fallback
}
