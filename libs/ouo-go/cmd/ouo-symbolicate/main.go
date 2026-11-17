// Command ouo-symbolicate reads the newest exception record of a project from Loki and
// resolves its stack with the debug files in Muninn (package symbolicate), the way the
// plugin backend does on read. It prints the symbolicate.Result as JSON. It is the
// read side of tests/e2e/symbolication, and a debugging aid for an operator.
//
//	ouo-symbolicate --loki URL --muninn URL --project p [--service s] [--contains text] [--since 30m]
//
// Muninn's read token (when it has one) comes from MUNINN_READ_TOKEN. Exit status 1 when
// no exception record matches or resolution failed.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
	"github.com/ouo11y/ouo11y/libs/ouo-go/symbolicate"
)

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "ouo-symbolicate:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("ouo-symbolicate", flag.ContinueOnError)
	lokiURL := fs.String("loki", "", "Loki base URL")
	muninnURL := fs.String("muninn", "", "Muninn base URL")
	tenant := fs.String("tenant", "anonymous", "Muninn tenant (X-Scope-OrgID)")
	project := fs.String("project", "", "ouo.project.id")
	service := fs.String("service", "", "service.name to match (any when empty)")
	contains := fs.String("contains", "", "text the record's message or stack must contain")
	since := fs.Duration("since", 30*time.Minute, "how far back to look")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *lokiURL == "" || *muninnURL == "" || *project == "" {
		return fmt.Errorf("--loki, --muninn and --project are required")
	}
	ev, err := newest(ctx, &ouogo.Loki{URL: *lokiURL}, *project, *service, *contains, *since)
	if err != nil {
		return err
	}
	e, ok := symbolicate.FromEvent(*project, ev)
	if !ok {
		return fmt.Errorf("the exception record has neither a stack nor native frames")
	}
	m := &ouogo.Muninn{URL: *muninnURL, Tenant: *tenant, ReadToken: os.Getenv("MUNINN_READ_TOKEN")}
	res, err := symbolicate.New(m, symbolicate.Options{}).Resolve(ctx, e)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(res)
}

// newest returns the newest exception record of project (and service) whose message or
// stack contains the text, as an ouogo.Event (the shape symbolicate.FromEvent reads).
func newest(ctx context.Context, l *ouogo.Loki, project, service, contains string, since time.Duration) (ouogo.Event, error) {
	sel := fmt.Sprintf(`{ouo_project_id=%q, event_name="exception"}`, project)
	if service != "" {
		sel += fmt.Sprintf(` | service_name=%q`, service)
	}
	to := time.Now()
	lines, err := l.QueryRange(ctx, sel, to.Add(-since), to, 500, true)
	if err != nil {
		return ouogo.Event{}, err
	}
	for _, line := range lines {
		a := line.Labels
		text := line.Body + "\n" + a["exception_message"] + "\n" + a["exception_stacktrace"]
		if contains != "" && !strings.Contains(text, contains) {
			continue
		}
		return ouogo.Event{Time: line.Time.UnixMilli(), Name: "exception", Attributes: a, Body: line.Body}, nil
	}
	return ouogo.Event{}, fmt.Errorf("no exception record of project %s matching %q in the last %s", project, contains, since)
}
