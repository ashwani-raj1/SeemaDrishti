package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Client struct {
	baseUrl   string
	authToken string
	http      *http.Client
}

func New(baseUrl string, authToken string) *Client {
	return &Client{
		baseUrl:   baseUrl,
		authToken: authToken,
		http:      &http.Client{Timeout: time.Second * 10},
	}

}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var reqBody io.Reader

	if c.authToken == "" {
		return fmt.Errorf("auth token is required")
	}

	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reqBody = bytes.NewBuffer(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseUrl+path, reqBody)
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+c.authToken)

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

	fmt.Printf("Response: %v\n", out)

	return nil

}

func (c *Client) Get(ctx context.Context, path string, out any) error {
	return c.do(ctx, http.MethodGet, path, nil, out)
}

func (c *Client) Post(ctx context.Context, path string, body any, out any) error {
	return c.do(ctx, http.MethodPost, path, body, out)
}
