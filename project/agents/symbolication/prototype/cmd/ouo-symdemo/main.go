// ouo-symdemo runs the ADR-0022 prototype end to end.
//
//	ouo-symdemo serve   -data <dir> -addr 127.0.0.1:0 -token ut_demo -project demo
//	    starts the debug-file store and the upload route in front of it and
//	    prints both URLs; `ouo-sourcemaps upload --url <edge>` uploads to it.
//	ouo-symdemo resolve -store <url> -project demo -release 1.4.2 -stack <file> [-debug-ids <json>]
//	    prints the symbolicated stack as JSON.
//	ouo-symdemo measure -runs 20 -map <file.map> [-bundle <file.js>] [-stack <file> -debug-ids <json>]
//	    uploads one map to a fresh store on loopback and prints the numbers of
//	    the report as JSON (one process per map, so memory is that map's).
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/ouo11y/ouo11y/project/agents/symbolication/prototype/debugfiles"
	"github.com/ouo11y/ouo11y/project/agents/symbolication/prototype/symbolicate"
)

const maxUpload = 256 << 20

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: ouo-symdemo serve|resolve|measure [flags]")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = serve(os.Args[2:])
	case "resolve":
		err = resolve(os.Args[2:])
	case "measure":
		err = measure(os.Args[2:])
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "ouo-symdemo:", err)
		os.Exit(1)
	}
}

// listen serves h on addr and returns its URL.
func listen(addr string, h http.Handler) (string, error) {
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return "", err
	}
	go http.Serve(l, h)
	return "http://" + l.Addr().String(), nil
}

// start runs the store and the edge route on two loopback ports.
func start(data, storeAddr, edgeAddr, token, project string) (storeURL, edgeURL string, err error) {
	if storeURL, err = listen(storeAddr, debugfiles.Handler(&debugfiles.FS{Root: data}, maxUpload)); err != nil {
		return
	}
	client := &debugfiles.Client{BaseURL: storeURL}
	edgeURL, err = listen(edgeAddr, debugfiles.EdgeHandler(client, map[string]string{token: project}, maxUpload))
	return
}

func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	data := fs.String("data", "", "directory of the store (required)")
	storeAddr := fs.String("store-addr", "127.0.0.1:0", "listen address of the store")
	edgeAddr := fs.String("edge-addr", "127.0.0.1:0", "listen address of the upload route")
	token := fs.String("token", "ut_demo", "upload token")
	project := fs.String("project", "demo", "project of the token")
	fs.Parse(args)
	if *data == "" {
		return fmt.Errorf("-data is required")
	}
	storeURL, edgeURL, err := start(*data, *storeAddr, *edgeAddr, *token, *project)
	if err != nil {
		return err
	}
	fmt.Printf("store %s\nedge %s\n", storeURL, edgeURL)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	<-stop
	return nil
}

func readDebugIDs(arg string) (map[string]string, error) {
	if arg == "" {
		return nil, nil
	}
	b := []byte(arg)
	if !strings.HasPrefix(strings.TrimSpace(arg), "{") {
		var err error
		if b, err = os.ReadFile(arg); err != nil {
			return nil, err
		}
	}
	var ids map[string]string
	return ids, json.Unmarshal(b, &ids)
}

func resolve(args []string) error {
	fs := flag.NewFlagSet("resolve", flag.ExitOnError)
	store := fs.String("store", "", "store URL (required)")
	project := fs.String("project", "demo", "project id")
	release := fs.String("release", "", "service.version of the record")
	stackFile := fs.String("stack", "", "file with exception.stacktrace (required)")
	ids := fs.String("debug-ids", "", "ouo.exception.debug_ids: JSON, or a file with it")
	fs.Parse(args)
	stack, err := os.ReadFile(*stackFile)
	if err != nil {
		return err
	}
	debugIDs, err := readDebugIDs(*ids)
	if err != nil {
		return err
	}
	sym := symbolicate.New(&debugfiles.Client{BaseURL: *store}, symbolicate.Options{})
	res, err := sym.Symbolicate(context.Background(), symbolicate.Request{ProjectID: *project, Release: *release, Stacktrace: string(stack), DebugIDs: debugIDs})
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(res)
}

type stats struct {
	Runs   int     `json:"runs"`
	Median float64 `json:"median_ms"`
	P95    float64 `json:"p95_ms"`
	Min    float64 `json:"min_ms"`
	Max    float64 `json:"max_ms"`
}

func summarize(d []time.Duration) stats {
	sort.Slice(d, func(i, j int) bool { return d[i] < d[j] })
	ms := func(x time.Duration) float64 { return float64(x.Nanoseconds()) / 1e6 }
	return stats{Runs: len(d), Median: ms(d[len(d)/2]), P95: ms(d[min(len(d)-1, len(d)*95/100)]), Min: ms(d[0]), Max: ms(d[len(d)-1])}
}

func heap() uint64 {
	runtime.GC()
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.HeapAlloc
}

func measure(args []string) error {
	fs := flag.NewFlagSet("measure", flag.ExitOnError)
	runs := fs.Int("runs", 20, "runs per number")
	mapFile := fs.String("map", "", "source map (required)")
	bundle := fs.String("bundle", "", "minified bundle of the map: a frame in its middle is made up when no -stack is given")
	stackFile := fs.String("stack", "", "file with a real exception.stacktrace")
	ids := fs.String("debug-ids", "", "ouo.exception.debug_ids of the real stack")
	fs.Parse(args)
	ctx := context.Background()

	raw, err := os.ReadFile(*mapFile)
	if err != nil {
		return err
	}
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(raw)
	zw.Close()

	data, err := os.MkdirTemp("", "ouo-symdemo-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(data)
	storeURL, edgeURL, err := start(data, "127.0.0.1:0", "127.0.0.1:0", "ut_demo", "demo")
	if err != nil {
		return err
	}
	client := &debugfiles.Client{BaseURL: storeURL}

	// The request of the stack: the real one, or one frame in the middle of the bundle.
	id := debugfiles.ContentDebugID(gz.Bytes())
	var head struct {
		DebugID string `json:"debugId"`
	}
	json.Unmarshal(raw, &head)
	if norm, ok := debugfiles.NormalizeDebugID(head.DebugID); ok {
		id = norm
	}
	req := symbolicate.Request{ProjectID: "demo"}
	synthetic := false
	if *stackFile != "" {
		b, err := os.ReadFile(*stackFile)
		if err != nil {
			return err
		}
		req.Stacktrace = string(b)
		if req.DebugIDs, err = readDebugIDs(*ids); err != nil {
			return err
		}
	} else {
		if *bundle == "" {
			return fmt.Errorf("-stack or -bundle is required")
		}
		js, err := os.ReadFile(*bundle)
		if err != nil {
			return err
		}
		// The longest line of the bundle, in its middle: minified code.
		line, col, n := 1, 1, 0
		for i, l := range bytes.Split(js, []byte("\n")) {
			if len(l) > n {
				line, col, n = i+1, len(l)/2, len(l)
			}
		}
		synthetic = true
		u := "https://app.example/assets/bundle.js"
		req.Stacktrace = fmt.Sprintf("Error: synthetic\n    at x (%s:%d:%d)", u, line, col)
		req.DebugIDs = map[string]string{u: id}
	}

	// Upload through the edge route, as the CLI does.
	t0 := time.Now()
	put, _ := http.NewRequest(http.MethodPut, edgeURL+"/v1/sourcemaps?file=/assets/bundle.js&debug_id="+id, bytes.NewReader(gz.Bytes()))
	put.Header.Set("Authorization", "Bearer ut_demo")
	res, err := http.DefaultClient.Do(put)
	if err != nil {
		return err
	}
	res.Body.Close()
	uploadMS := float64(time.Since(t0).Nanoseconds()) / 1e6
	if res.StatusCode != http.StatusCreated {
		return fmt.Errorf("upload: %s", res.Status)
	}

	// Cold: a new Symbolicator each run (store GET, gunzip, parse, lookup).
	var cold, warm, missCold, missWarm []time.Duration
	var result symbolicate.Result
	for range *runs {
		sym := symbolicate.New(client, symbolicate.Options{})
		t := time.Now()
		if result, err = sym.Symbolicate(ctx, req); err != nil {
			return err
		}
		cold = append(cold, time.Since(t))
	}
	// Memory: what one parsed map keeps on the heap.
	before := heap()
	sym := symbolicate.New(client, symbolicate.Options{})
	if _, err := sym.Symbolicate(ctx, req); err != nil {
		return err
	}
	retained := int64(heap()) - int64(before)
	// Warm: the map is in the cache.
	for range *runs {
		t := time.Now()
		sym.Symbolicate(ctx, req)
		warm = append(warm, time.Since(t))
	}
	// Missing map: a debug id the store does not have.
	missing := symbolicate.Request{ProjectID: "demo", Stacktrace: req.Stacktrace, DebugIDs: map[string]string{}}
	for u := range req.DebugIDs {
		missing.DebugIDs[u] = "deadbeef-0000-4000-8000-000000000000"
	}
	var missResult symbolicate.Result
	for range *runs {
		s := symbolicate.New(client, symbolicate.Options{})
		t := time.Now()
		missResult, _ = s.Symbolicate(ctx, missing)
		missCold = append(missCold, time.Since(t))
		t = time.Now()
		s.Symbolicate(ctx, missing)
		missWarm = append(missWarm, time.Since(t))
	}
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	runtime.KeepAlive(sym)

	out := map[string]any{
		"map":               *mapFile,
		"map_bytes":         len(raw),
		"stored_bytes":      gz.Len(),
		"synthetic_frame":   synthetic,
		"frames":            len(result.Frames),
		"status":            result.Status,
		"upload_ms":         uploadMS,
		"cold":              summarize(cold),
		"warm":              summarize(warm),
		"miss_cold":         summarize(missCold),
		"miss_warm":         summarize(missWarm),
		"miss_status":       missResult.Status,
		"heap_retained":     retained,
		"process_sys_bytes": ms.Sys,
		"resolved":          result.Stacktrace,
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}
