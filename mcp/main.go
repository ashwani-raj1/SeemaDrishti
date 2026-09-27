package main

import (
	"log"
	"mcp/internals/backend"
	"mcp/internals/tools"
	"os"

	"github.com/mark3labs/mcp-go/server"
)

func main() {

	log.Println("Starting MCP server...")

	baseURL := getVar("BACKEND_URL", "http://localhost:8000")
	authToken := os.Getenv("BACKEND_AUTH_TOKEN")
	addr := getVar("MCP_ADDR", ":13000")

	api := backend.New(baseURL, authToken)

	mcpServer := server.NewMCPServer(
		"seemadrishti-mcp",
		"0.1.0",
		server.WithToolCapabilities(true),
	)

	tools.RegisterIncidentTools(api, mcpServer)

	httpServer := server.NewStreamableHTTPServer(
		mcpServer,
		server.WithStateLess(true),
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
