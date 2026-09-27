package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// ActorHeader is how the backend names the caller. The MCP server never
// invents one: it only forwards what its own caller sent.
const ActorHeader = "x-ibvap-actor"

type actorKey struct{}

// WithActor stores the caller's actor id so every backend request made while
// handling that call carries it.
func WithActor(ctx context.Context, actor string) context.Context {
	return context.WithValue(ctx, actorKey{}, actor)
}

type Client struct {
	baseUrl string
	http    *http.Client
}

func New(baseUrl string) *Client {
	return &Client{
		baseUrl: baseUrl,
		http:    &http.Client{Timeout: time.Second * 10},
	}

}

func (c *Client) do(ctx context.Context, method, path string, query url.Values, body any, out any) error {
	var reqBody io.Reader

	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reqBody = bytes.NewBuffer(b)
	}

	endpoint := c.baseUrl + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, method, endpoint, reqBody)
	if err != nil {
		return err
	}

	req.Header.Set("Accept", "application/json")
	if actor, _ := ctx.Value(actorKey{}).(string); actor != "" {
		req.Header.Set(ActorHeader, actor)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}

	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)

	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("backend %s %s returned %d: %s", method, path, resp.StatusCode, string(respBody))
	}

	if out == nil {
		return nil
	}

	if err := json.Unmarshal(respBody, out); err != nil {
		return err
	}

	// fmt.Printf("Response: %v\n", out)

	return nil

}

func (c *Client) Get(ctx context.Context, path string, query url.Values, out any) error {
	return c.do(ctx, http.MethodGet, path, query, nil, out)
}

func (c *Client) Post(ctx context.Context, path string, body any, out any) error {
	return c.do(ctx, http.MethodPost, path, nil, body, out)
}
