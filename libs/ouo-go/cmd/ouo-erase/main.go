// Command ouo-erase deletes one user's or one project's RUM data across Loki, Tempo and
// Muninn and records it in Muninn's audit entries (ADR-0026 section 5). It is run by the
// operator, with the operator's credentials, on request.
//
//	ouo-erase user <user id> [--project p] [flags]
//	ouo-erase project <project> [flags]
//	ouo-erase audit [--entry id]
//
// user and project print the final audit record as JSON (complete, even when the stored
// one had to be cut to Muninn's 64 KiB limit) and exit 1 when anything failed; audit prints
// the stored records. Muninn's read token comes from MUNINN_READ_TOKEN, Tempo's bearer
// (when it has one) from OUO_TEMPO_TOKEN: tokens never go on the command line.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"time"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
	"github.com/ouo11y/ouo11y/libs/ouo-go/erase"
)

const usage = `usage:
  ouo-erase user <user id> [--project p] [flags]   delete one user's data
  ouo-erase project <project> [flags]              delete one project's data
  ouo-erase audit [--entry id]                     list audit records

Run "ouo-erase <command> -h" for the flags.`

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
}

// config is what every command reads.
type config struct {
	muninnURL, tenant                string
	lokiURL, lokiDeleteURL, tempoURL string
	actor, reason, project, entry    string
	dryRun, lokiDelete               bool
	logRetention                     time.Duration
}

func envOr(env func(string) string, key, def string) string {
	if v := env(key); v != "" {
		return v
	}
	return def
}

func flags(name string, env func(string) string, stderr io.Writer) (*flag.FlagSet, *config) {
	c := &config{}
	fs := flag.NewFlagSet("ouo-erase "+name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&c.muninnURL, "muninn-url", envOr(env, "OUO_MUNINN_URL", "http://localhost:3400"), "Muninn base URL (env OUO_MUNINN_URL)")
	fs.StringVar(&c.tenant, "tenant", env("OUO_TENANT"), "X-Scope-OrgID sent to Muninn (default anonymous), and to Loki and Tempo when set (env OUO_TENANT)")
	if name == "audit" {
		fs.StringVar(&c.entry, "entry", "", "only this entry id")
		return fs, c
	}
	fs.StringVar(&c.lokiURL, "loki-url", envOr(env, "OUO_LOKI_URL", "http://localhost:3100"), "Loki base URL (env OUO_LOKI_URL)")
	fs.StringVar(&c.lokiDeleteURL, "loki-delete-url", env("OUO_LOKI_DELETE_URL"), "base URL of Loki's delete API (the compactor) when it is not --loki-url (env OUO_LOKI_DELETE_URL)")
	fs.StringVar(&c.tempoURL, "tempo-url", env("OUO_TEMPO_URL"), "Tempo base URL; empty skips listing trace ids (env OUO_TEMPO_URL)")
	fs.StringVar(&c.actor, "actor", env("USER"), "who runs the deletion, for the audit record")
	fs.StringVar(&c.reason, "reason", "", "why, for the audit record (a ticket)")
	fs.BoolVar(&c.dryRun, "dry-run", false, "report what would be deleted, delete nothing (still audited, marked dry_run)")
	fs.BoolVar(&c.lokiDelete, "loki-delete", true, "submit a Loki delete request")
	fs.DurationVar(&c.logRetention, "log-retention", 720*time.Hour, "Loki's retention: the window searched and deleted")
	if name == "user" {
		fs.StringVar(&c.project, "project", "", "only this project")
	}
	return fs, c
}

// parse parses flags placed before or after the positional arguments.
func parse(fs *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		if fs.NArg() == 0 {
			return pos, nil
		}
		pos = append(pos, fs.Arg(0))
		args = fs.Args()[1:]
	}
}

func run(ctx context.Context, args []string, env func(string) string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	cmd := args[0]
	if cmd != "user" && cmd != "project" && cmd != "audit" {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	fs, c := flags(cmd, env, stderr)
	pos, err := parse(fs, args[1:])
	if err != nil {
		return 2
	}
	want := 1
	if cmd == "audit" {
		want = 0
	}
	if len(pos) != want {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	mn := &ouogo.Muninn{URL: c.muninnURL, Tenant: c.tenant, ReadToken: env("MUNINN_READ_TOKEN")}
	out := json.NewEncoder(stdout)
	out.SetIndent("", "  ")

	if cmd == "audit" {
		recs, err := mn.Audit(ctx, c.entry)
		if err != nil {
			fmt.Fprintln(stderr, "ouo-erase:", err)
			return 1
		}
		_ = out.Encode(map[string]any{"entries": recs})
		return 0
	}

	e := &erase.Eraser{
		Loki:          &ouogo.Loki{URL: c.lokiURL, OrgID: c.tenant},
		LokiDeleteURL: c.lokiDeleteURL,
		LokiDelete:    c.lokiDelete,
		Muninn:        mn,
		LogRetention:  c.logRetention,
	}
	if c.tempoURL != "" {
		e.Tempo = &erase.Tempo{URL: c.tempoURL, OrgID: c.tenant, Token: env("OUO_TEMPO_TOKEN")}
	}
	req := erase.Request{Actor: c.actor, Reason: c.reason, DryRun: c.dryRun}
	var rec *erase.Record
	if cmd == "user" {
		req.UserID, req.Project = pos[0], c.project
		rec, err = e.User(ctx, req)
	} else {
		req.Project = pos[0]
		rec, err = e.Project(ctx, req)
	}
	if rec != nil {
		_ = out.Encode(rec)
	}
	if err != nil {
		if errors.Is(err, erase.ErrAudit) {
			fmt.Fprintln(stderr, "ouo-erase: nothing was deleted:", err)
		} else {
			fmt.Fprintln(stderr, "ouo-erase:", err)
		}
		return 1
	}
	return 0
}
