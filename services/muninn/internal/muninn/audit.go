package muninn

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/ouo11y/ouo11y/services/muninn/internal/store"
)

// Audit entries, docs/specs/muninn.md section 14: create-only records of the
// erasures ouo-erase runs. Muninn never updates or deletes one.

var reEntry = regexp.MustCompile(`^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$`)

var auditStatuses = map[string]int{"started": 0, "completed": 1, "failed": 1}

const maxAuditBytes = 64 << 10

// PUT /api/v1/audit/{entry}/{status} (AUD-1, AUD-2).
func (s *Server) putAudit(w http.ResponseWriter, r *http.Request) {
	tenant, ok := s.admin(w, r)
	if !ok {
		return
	}
	entry, status := r.PathValue("entry"), r.PathValue("status")
	if _, known := auditStatuses[status]; !reEntry.MatchString(entry) || !known {
		writeError(w, r, http.StatusBadRequest, "malformed entry id or status")
		return
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, maxAuditBytes+1))
	if err != nil || len(b) > maxAuditBytes {
		writeError(w, r, http.StatusBadRequest, "body is not a JSON object of at most 65536 bytes")
		return
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(b, &obj) != nil || obj == nil {
		writeError(w, r, http.StatusBadRequest, "body is not a JSON object of at most 65536 bytes")
		return
	}
	k := s.keys.audit + tenant + "/" + entry + "/" + status + ".json"
	err = s.store.Create(r.Context(), k, b, nil)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusCreated)
	case errors.Is(err, store.ErrExists):
		old, gerr := s.store.Get(r.Context(), k)
		if gerr != nil {
			storeFailure(w, r, gerr)
			return
		}
		if !bytes.Equal(old, b) {
			writeError(w, r, http.StatusConflict, "audit record "+entry+"/"+status+" already stored with other content")
			return
		}
		w.WriteHeader(http.StatusOK)
	default:
		storeFailure(w, r, err)
	}
}

// GET /api/v1/audit[?entry=] (AUD-3): oldest entry first, started before its outcome.
func (s *Server) listAudit(w http.ResponseWriter, r *http.Request) {
	tenant, ok := s.admin(w, r)
	if !ok {
		return
	}
	prefix := s.keys.audit + tenant + "/"
	if e := r.URL.Query().Get("entry"); e != "" {
		if !reEntry.MatchString(e) {
			writeError(w, r, http.StatusBadRequest, "malformed entry id")
			return
		}
		prefix += e + "/"
	}
	objs, err := s.store.List(r.Context(), prefix)
	if err != nil {
		storeFailure(w, r, err)
		return
	}
	type rec struct {
		Entry  string          `json:"entry"`
		Status string          `json:"status"`
		Record json.RawMessage `json:"record"`
	}
	out := []rec{}
	for _, o := range objs {
		parts := strings.Split(strings.TrimPrefix(o.Key, s.keys.audit+tenant+"/"), "/")
		if len(parts) != 2 || !reEntry.MatchString(parts[0]) {
			continue
		}
		status := strings.TrimSuffix(parts[1], ".json")
		if _, known := auditStatuses[status]; !known {
			continue
		}
		b, err := s.store.Get(r.Context(), o.Key)
		if err != nil {
			storeFailure(w, r, err)
			return
		}
		out = append(out, rec{Entry: parts[0], Status: status, Record: b})
	}
	slices.SortFunc(out, func(a, b rec) int {
		if c := strings.Compare(a.Entry, b.Entry); c != 0 {
			return c
		}
		return auditStatuses[a.Status] - auditStatuses[b.Status]
	})
	writeJSON(w, r, http.StatusOK, map[string]any{"entries": out})
}
