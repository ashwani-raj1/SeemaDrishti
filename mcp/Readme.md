mcpserver/
├── go.mod
├── main.go
└── internal/
    ├── backend/
    │   └── client.go
    └── tools/
        ├── users.go
        └── events.go   (one file per entity — copy this pattern for each new one)

go get github.com/mark3labs/mcp-go/server@v1.1.1
go mod tidy
