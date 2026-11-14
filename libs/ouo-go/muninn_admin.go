package ouogo

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
)

// Muninn's delete API (spec section 8) and audit entries (spec section 14). They take the
// same read token and tenant header as the reads; ouo-erase (package erase) calls them.

// ProjectDeleteCounts is the answer of DeleteProject (MUN-45).
type ProjectDeleteCounts struct {
	Replays    int `json:"replays"`
	DebugFiles int `json:"debug_files"`
}

// Audit entry statuses (AUD-1).
const (
	AuditStarted   = "started"
	AuditCompleted = "completed"
	AuditFailed    = "failed"
)

// MaxAuditRecord is the largest record body Muninn takes (AUD-1).
const MaxAuditRecord = 65536

// reAuditEntry is the entry id: UTC start time, then 8 random hex digits (AUD-1).
var reAuditEntry = regexp.MustCompile(`^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$`)

// AuditRecord is one stored audit object.
type AuditRecord struct {
	Entry  string          `json:"entry"`
	Status string          `json:"status"`
	Record json.RawMessage `json:"record"`
}

// AuditConflictError is a PutAudit whose entry and status already hold other bytes
// (AUD-2: 409). The first record stays.
type AuditConflictError struct{ Entry, Status string }

func (e *AuditConflictError) Error() string {
	return fmt.Sprintf("muninn: audit entry %s/%s already exists with other content", e.Entry, e.Status)
}

func checkAudit(entry, status string) error {
	if !reAuditEntry.MatchString(entry) {
		return &BadRequestError{Msg: "audit entry must match ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$"}
	}
	switch status {
	case AuditStarted, AuditCompleted, AuditFailed:
		return nil
	}
	return &BadRequestError{Msg: "audit status must be started, completed or failed"}
}

// send makes one request with the tenant and token headers. Any answer is returned; a
// transport failure is a BackendError.
func (m *Muninn) send(ctx context.Context, method, path string, body []byte) (*http.Response, error) {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, m.URL+path, r)
	if err != nil {
		return nil, err
	}
	tenant := m.Tenant
	if tenant == "" {
		tenant = "anonymous"
	}
	req.Header.Set("X-Scope-OrgID", tenant)
	if m.ReadToken != "" {
		req.Header.Set("Authorization", "Bearer "+m.ReadToken)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept-Encoding", "gzip")
	resp, err := httpClient(m.HTTP).Do(req)
	if err != nil {
		return nil, &BackendError{Backend: "muninn", Err: err}
	}
	return resp, nil
}

func statusError(resp *http.Response) error {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
	return &BackendError{Backend: "muninn", Err: fmt.Errorf("%s: %s", resp.Status, b)}
}

// DeleteSessionReplays deletes every replay of a session, each behind its own tombstone
// (MUN-40, MUN-41). Idempotent: a session without replays is not an error.
func (m *Muninn) DeleteSessionReplays(ctx context.Context, project, session string) error {
	if err := checkProject(project); err != nil {
		return err
	}
	if err := checkID("session", session); err != nil {
		return err
	}
	resp, err := m.send(ctx, http.MethodDelete, replaysPath(project, session), nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		return statusError(resp)
	}
	return nil
}

// DeleteProject deletes every replay and debug file of a project (MUN-45) and returns
// what was removed. Idempotent: a second call answers zero counts.
func (m *Muninn) DeleteProject(ctx context.Context, project string) (ProjectDeleteCounts, error) {
	var c ProjectDeleteCounts
	if err := checkProject(project); err != nil {
		return c, err
	}
	resp, err := m.send(ctx, http.MethodDelete, "/api/v1/projects/"+project, nil)
	if err != nil {
		return c, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return c, statusError(resp)
	}
	body, err := decoded(resp)
	if err != nil {
		return c, &BackendError{Backend: "muninn", Err: err}
	}
	if err := json.Unmarshal(body, &c); err != nil {
		return c, &BackendError{Backend: "muninn", Err: fmt.Errorf("decode: %w", err)}
	}
	return c, nil
}

// PutAudit stores one audit record, create-only (AUD-2). A new key (201) and the same
// bytes again (200) succeed; other bytes under the same key are an *AuditConflictError.
// record is marshalled to JSON and must be an object of at most MaxAuditRecord bytes.
func (m *Muninn) PutAudit(ctx context.Context, entry, status string, record any) error {
	if err := checkAudit(entry, status); err != nil {
		return err
	}
	body, err := json.Marshal(record)
	if err != nil {
		return &BadRequestError{Msg: "audit record: " + err.Error()}
	}
	if len(body) > MaxAuditRecord {
		return &BadRequestError{Msg: fmt.Sprintf("audit record is %d bytes, more than %d", len(body), MaxAuditRecord)}
	}
	if len(body) == 0 || body[0] != '{' {
		return &BadRequestError{Msg: "audit record must be a JSON object"}
	}
	resp, err := m.send(ctx, http.MethodPut, "/api/v1/audit/"+entry+"/"+status, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusCreated, http.StatusOK:
		return nil
	case http.StatusConflict:
		return &AuditConflictError{Entry: entry, Status: status}
	}
	return statusError(resp)
}

// Audit lists the tenant's audit records, oldest first: every entry when entry is empty,
// else that entry's records (started, then completed or failed). Never nil.
func (m *Muninn) Audit(ctx context.Context, entry string) ([]AuditRecord, error) {
	path := "/api/v1/audit"
	if entry != "" {
		if !reAuditEntry.MatchString(entry) {
			return nil, &BadRequestError{Msg: "audit entry must match ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$"}
		}
		path += "?" + url.Values{"entry": {entry}}.Encode()
	}
	resp, err := m.send(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, statusError(resp)
	}
	body, err := decoded(resp)
	if err != nil {
		return nil, &BackendError{Backend: "muninn", Err: err}
	}
	var a struct {
		Entries []AuditRecord `json:"entries"`
	}
	if err := json.Unmarshal(body, &a); err != nil {
		return nil, &BackendError{Backend: "muninn", Err: fmt.Errorf("decode: %w", err)}
	}
	if a.Entries == nil {
		a.Entries = []AuditRecord{}
	}
	return a.Entries, nil
}
