package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// replay sends the requests of a capture directory again (method, path,
// query, headers and raw body as recorded), round robin, and prints the
// latency percentiles and status counts as JSON. It measures what an SDK
// would see from the target: a dropped connection counts as status 0.
func replay(args []string) int {
	fs := flag.NewFlagSet("replay", flag.ExitOnError)
	dir := fs.String("dir", "", "capture directory (request.json + body.bin per request)")
	target := fs.String("target", "", "base URL (scheme://host:port) to send to")
	n := fs.Int("n", 0, "requests to send (default: each captured request once)")
	c := fs.Int("c", 1, "concurrent senders")
	rate := fs.Float64("rate", 0, "requests per second over all senders (0: as fast as possible)")
	label := fs.String("label", "", "label printed with the result")
	_ = fs.Parse(args)
	if *dir == "" || *target == "" {
		fmt.Fprintln(os.Stderr, "usage: sentrytap replay -dir <capture> -target <base URL> [-n N] [-c C] [-rate R]")
		return 2
	}
	caps, err := load(*dir)
	if err != nil || len(caps) == 0 {
		fmt.Fprintln(os.Stderr, "no captures:", err)
		return 2
	}
	bodies := make([][]byte, len(caps))
	for i, cp := range caps {
		if bodies[i], err = os.ReadFile(filepath.Join(cp.dir, "body.bin")); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
	}
	total := *n
	if total <= 0 {
		total = len(caps)
	}
	client := &http.Client{Timeout: 60 * time.Second, Transport: &http.Transport{DisableCompression: true, MaxIdleConnsPerHost: *c}}
	var next atomic.Int64
	var mu sync.Mutex
	lat := make([]float64, 0, total)
	status := map[int]int{}
	var tick <-chan time.Time
	if *rate > 0 {
		t := time.NewTicker(time.Duration(float64(time.Second) / *rate))
		defer t.Stop()
		tick = t.C
	}
	start := time.Now()
	var wg sync.WaitGroup
	for range max(*c, 1) {
		wg.Go(func() {
			for {
				i := int(next.Add(1)) - 1
				if i >= total {
					return
				}
				if tick != nil {
					<-tick
				}
				cp := caps[i%len(caps)]
				url := *target + cp.req.Path
				if cp.req.RawQuery != "" {
					url += "?" + cp.req.RawQuery
				}
				req, _ := http.NewRequest(cp.req.Method, url, bytes.NewReader(bodies[i%len(caps)]))
				for k, vs := range cp.req.Header {
					if k != "Content-Length" && k != "X-Forwarded-For" && !hopHeaders[k] {
						req.Header[k] = vs
					}
				}
				t0 := time.Now()
				code := 0
				if resp, err := client.Do(req); err == nil {
					_, _ = io.Copy(io.Discard, resp.Body)
					resp.Body.Close()
					code = resp.StatusCode
				}
				d := float64(time.Since(t0).Microseconds()) / 1000
				mu.Lock()
				lat = append(lat, d)
				status[code]++
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	elapsed := time.Since(start)
	sort.Float64s(lat)
	pct := func(p float64) float64 { return lat[min(len(lat)-1, int(p*float64(len(lat))))] }
	out := map[string]any{
		"label": *label, "target": *target, "requests": len(lat), "concurrency": *c,
		"elapsed_s": elapsed.Seconds(), "rps": float64(len(lat)) / elapsed.Seconds(),
		"p50_ms": pct(0.50), "p90_ms": pct(0.90), "p99_ms": pct(0.99), "max_ms": lat[len(lat)-1],
		"status": status,
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
	if status[0] > 0 {
		return 1
	}
	return 0
}
