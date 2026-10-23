package httpapi

import (
	"net/http"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/replay"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
)

// vitalsResponse is GET /v1/sessions/{id}/vitals (mobile vitals spec
// section 7).
type vitalsResponse struct {
	SessionID string                `json:"session_id"`
	Summary   session.VitalsSummary `json:"summary"`
	Vitals    []session.Vital       `json:"vitals"`
}

func (s *Server) getSessionVitals(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !replay.ValidSessionID(id) {
		writeError(w, http.StatusBadRequest, "invalid session id")
		return
	}
	rec, err := s.lookupSession(r, id)
	if err != nil {
		s.lokiError(w, err)
		return
	}
	if rec == nil {
		writeError(w, http.StatusNotFound, "session not found: "+id)
		return
	}
	vitals, summary := session.Vitals(rec.Events)
	writeJSON(w, http.StatusOK, vitalsResponse{SessionID: id, Summary: summary, Vitals: vitals})
}
