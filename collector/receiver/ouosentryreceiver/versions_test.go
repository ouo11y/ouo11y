package ouosentryreceiver

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Supported Sentry SDK range (checklist N3, docs/compatibility.md): one golden journey per
// captured @sentry/react-native version, recorded with collector/tools/sentrytap in front of the
// bridge while examples/sentry-mobile ran `scripts/run.sh --full` (launch, navigation, network,
// a shop round, errors, 40 s background, native crash, relaunch).
type goldenVersion struct {
	dir   string // testdata/golden/<dir>/journey
	sdk   string // envelope sdk.version of the JS layer
	cocoa string // sentry-cocoa version in the User-Agent
	crash string // exception.type of Sentry.nativeCrash()
	// What the version sends. 7.11 under Expo 57 (React Native 0.86) traces no fetch (so no
	// http.client spans and no traceparent), has no app start measurement, reports TTID in days
	// (dropped, mobile-vitals spec section 3) and stamps transactions hours in the past
	// (txClockSkew): its spans and transaction-derived records land outside their sessions.
	httpSpans, appStart, ttid, txClockSkew bool
}

var goldenVersions = []goldenVersion{
	{dir: "ios-rn-7.11.0", sdk: "7.11.0", cocoa: "8.58.0", crash: "EXC_BREAKPOINT", txClockSkew: true},
	{dir: "ios-rn-8.32.0", sdk: "8.32.0", cocoa: "9.31.0", crash: "EXC_BAD_ACCESS", httpSpans: true, appStart: true, ttid: true},
}

func TestGoldenVersions(t *testing.T) {
	// Every captured version has a row, so a new capture cannot go untested.
	dirs, _ := filepath.Glob("testdata/golden/ios-rn-*/journey")
	known := map[string]bool{"ios-rn-8.30.0": true} // covered by golden_test.go
	for _, v := range goldenVersions {
		known[v.dir] = true
	}
	for _, d := range dirs {
		if v := filepath.Base(filepath.Dir(d)); !known[v] {
			t.Errorf("%s has no row in goldenVersions", v)
		}
	}

	for _, v := range goldenVersions {
		t.Run(v.dir, func(t *testing.T) {
			reqs := loadGolden(t, filepath.Join("testdata/golden", v.dir, "journey"))
			for _, g := range reqs {
				if ua := strings.Join(g.Header["User-Agent"], ""); !strings.Contains(ua, v.cocoa) {
					t.Fatalf("request %d from %q, want sentry-cocoa %s", g.Seq, ua, v.cocoa)
				}
			}
			x := newTx(t)
			replayGolden(t, x, reqs)
			g := summarize(t, x)
			if !v.txClockSkew {
				checkInvariants(t, x, g)
			} else {
				// The skew itself, so a fixed SDK shows up here: transactions start more than an
				// hour before the first session.
				first := g.starts[""].ts
				for _, r := range g.starts {
					if first.IsZero() || r.ts.Before(first) {
						first = r.ts
					}
				}
				var skewed int
				for _, s := range x.spans() {
					if s.StartTimestamp().AsTime().Before(first.Add(-time.Hour)) {
						skewed++
					}
				}
				if skewed == 0 {
					t.Error("no transaction is skewed any more: re-check this version and drop txClockSkew")
				}
			}

			// Sessions: the first ends in the background, the second crashes (native crash), the
			// third is started by the relaunch.
			reasons := map[string]int{}
			for _, r := range g.ends {
				reasons[r.attrs["ouo.session.end_reason"].(string)]++
			}
			if len(g.starts) < 3 || reasons["background"] < 1 || reasons["crash"] != 1 {
				t.Errorf("sessions: %d started, end reasons %v", len(g.starts), reasons)
			}
			var fatal, handled int
			for _, e := range g.exceptions {
				if e.attrs["ouo.exception.fatal"] == true {
					fatal++
					if e.attrs["exception.type"] != v.crash {
						t.Errorf("fatal exception %v", e.attrs["exception.type"])
					}
				} else {
					handled++
				}
			}
			if fatal != 1 || handled < 2 {
				t.Errorf("exceptions: %d fatal, %d handled", fatal, handled)
			}
			if len(x.byName("sentry.message")) != 1 {
				t.Errorf("sentry.message records: %d", len(x.byName("sentry.message")))
			}
			logs := len(x.byName("log")) + len(x.byName("console"))
			if len(g.chunks) == 0 || len(g.navigations) < 3 || logs == 0 {
				t.Errorf("replay chunks %d, navigations %d, logs and console lines %d", len(g.chunks), len(g.navigations), logs)
			}
			// Failed requests come from http.client spans (spec section 7).
			if n := len(g.failed); v.httpSpans && n < 2 || !v.httpSpans && n != 0 {
				t.Errorf("http.request.failed: %d (version traces fetch: %v)", n, v.httpSpans)
			}

			var client int
			for _, s := range x.spans() {
				if a := s.Attributes().AsRaw(); a["http.request.method"] != nil && a["url.full"] != nil {
					client++
				}
			}
			if v.httpSpans && client < 20 || !v.httpSpans && client > 2 {
				t.Errorf("http.client spans: %d (version traces fetch: %v)", client, v.httpSpans)
			}
			if got := len(x.byName(eventAppStart)) > 0; got != v.appStart {
				t.Errorf("ouo.app.start emitted: %v, want %v", got, v.appStart)
			}
			disp := x.byName(eventScreenDisplay)
			if got := len(disp) > 0; got != v.ttid {
				t.Errorf("ouo.screen.display emitted: %v (%d), want %v", got, len(disp), v.ttid)
			}
			for _, r := range disp {
				if ms, _ := r.attrs["ouo.screen.ttid_ms"].(float64); ms <= 0 || ms > 60000 {
					t.Errorf("TTID %v ms", ms)
				}
			}
			if len(x.byName(eventJank)) == 0 {
				t.Error("no app.jank: every captured version reports frames")
			}
		})
	}
}

func TestGoldenVersionsHaveNoSecrets(t *testing.T) {
	err := filepath.Walk("testdata/golden", func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || filepath.Base(p) != "request.json" {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		for _, h := range []string{"Authorization", "Cookie"} {
			if strings.Contains(string(b), `"`+h+`"`) {
				t.Errorf("%s carries %s", p, h)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
