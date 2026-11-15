package symbolicate

import (
	"encoding/json"
	"strings"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
)

// FromEvent builds the Exception of an event read with ouogo.Loki.SessionEvents (an
// exception record) of project: exception.stacktrace, ouo.exception.debug_ids,
// service.version, for a native crash ouo.crash.frames and ouo.crash.images, and for
// an Android one its JVM frames (in ouo.crash.frames) and ouo.exception.mapping_id. Keys
// are read in Loki's "_" spelling, then the "." one. ok is false when the event has
// neither a stack nor native frames. Malformed JSON values are left out: without debug
// ids a frame falls back to the release, without frames the stack is read as JavaScript.
func FromEvent(project string, ev ouogo.Event) (e Exception, ok bool) {
	attr := func(k string) string {
		if v := ev.Attributes[k]; v != "" {
			return v
		}
		// ouo_exception_debug_ids -> ouo.exception.debug_ids: only the namespace dots.
		return ev.Attributes[dotted[k]]
	}
	e = Exception{Project: project, Release: attr("service_version"), Stacktrace: attr("exception_stacktrace")}
	if raw := attr("ouo_exception_debug_ids"); raw != "" {
		_ = json.Unmarshal([]byte(raw), &e.DebugIDs)
	}
	if raw := attr("ouo_crash_frames"); raw != "" {
		var frames []struct {
			NativeFrame
			JVMFrame
		}
		if json.Unmarshal([]byte(raw), &frames) == nil {
			for _, f := range frames {
				if f.InstructionAddr == "" && f.Module != "" {
					e.JVMFrames = append(e.JVMFrames, f.JVMFrame)
				} else {
					e.Frames = append(e.Frames, f.NativeFrame)
				}
			}
			// Android frames are JVM frames, all of them; a mix is not a stack we can read.
			if len(e.JVMFrames) > 0 && len(e.Frames) > 0 {
				e.JVMFrames, e.Frames = nil, nil
			}
			if len(e.Frames) > 0 {
				_ = json.Unmarshal([]byte(attr("ouo_crash_images")), &e.Images)
			}
		}
		e.MappingID = attr("ouo_exception_mapping_id")
	}
	return e, strings.TrimSpace(e.Stacktrace) != "" || len(e.Frames) > 0 || len(e.JVMFrames) > 0
}

var dotted = map[string]string{
	"service_version":          "service.version",
	"exception_stacktrace":     "exception.stacktrace",
	"ouo_exception_debug_ids":  "ouo.exception.debug_ids",
	"ouo_crash_frames":         "ouo.crash.frames",
	"ouo_crash_images":         "ouo.crash.images",
	"ouo_exception_mapping_id": "ouo.exception.mapping_id",
}
