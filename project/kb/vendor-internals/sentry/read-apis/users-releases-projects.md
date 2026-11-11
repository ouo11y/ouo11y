# Sentry users, releases, projects, orgs and keys

> What does Muninn read to discover a customer's Sentry setup, and where does "user" data live?

Versions: Sentry self-hosted 26.10.0 (tag `26.10.0`). Research date 2026-11-10.

## Discovery endpoints

| Method and path | Status | Scope | Used for | Source |
|---|---|---|---|---|
| `GET /api/0/organizations/` | public | `org:read` | Orgs the token sees, with `links.organizationUrl` and `links.regionUrl` | [orgs-list.json](fixtures/orgs-list.json) |
| `GET /api/0/organizations/{org}/` | public | `org:read` | Org details | [organization_details.py#L1090](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/core/endpoints/organization_details.py#L1090) |
| `GET /api/0/organizations/{org}/projects/` | public | `org:read` | Project ids, slugs, platforms, `hasReplays`, `hasSessions`, `hasLogs`, `hasProfiles` flags | [organization_projects.py#L126](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/core/endpoints/organization_projects.py#L126) |
| `GET /api/0/projects/{org}/{project}/keys/` | public | `project:read` | DSNs (public and secret key, and per-endpoint URLs incl. `otlp_traces`, `otlp_logs`) | [project_keys.py#L31](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/core/endpoints/project_keys.py#L31) |
| `GET /api/0/organizations/{org}/project-keys/` | public | `org:read` | All keys of the org in one call | [organization_project_keys.py#L27](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_project_keys.py#L27) |
| `GET /api/0/organizations/{org}/releases/` | public | `project:read` (org tokens: `org:ci`) | Release list, `health=1` for crash-free data | [organization_releases.py#L333](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_releases.py#L333) |

Observed: the project `hasReplays` flag was `True` only for projects that had received a replay before today; new projects that got replays today still showed `False`, so do not use it to skip projects. Key responses contain secrets; the key `id` **is** the public key ([project-keys.json](fixtures/project-keys.json), redacted). Muninn does not need key secrets for reading and should not request or store them.

## Users: there is no user resource

| Where | What you get | Observed |
|---|---|---|
| Replay `user` field (R1/R2) | `{id, username, email, ip, geo{city,country_code,region,subdivision}, display_name}` | `ip` was filled with the Docker gateway address because Relay infers it from the client IP |
| Event `user` and `user` tag | `{id, email, username, ip_address, name, geo, data}`; tag `user` = `id:...`, `ip:...` etc. | [issue-event-latest.json](fixtures/issue-event-latest.json) |
| `GET /organizations/{org}/tags/user/values/` | Distinct `user` tag values with `count`, `firstSeen`, `lastSeen` | private, [organization_tagkey_values.py#L36](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/api/endpoints/organization_tagkey_values.py#L36); `dataset=replays` works too ([tag-user-values.json](fixtures/tag-user-values.json)) |
| `GET /projects/{org}/{project}/users/` | Event users of a project | public, but limited to **5 per 60 s per org** on SaaS ([project_users.py#L39](https://github.com/getsentry/sentry/blob/26.10.0/src/sentry/core/endpoints/project_users.py#L39)) |
| `GET /organizations/{org}/issues/{id}/tags/user/values/` | Users of one issue | public |
| Spans / logs | `user.id`, `user.email` etc. as attributes when the SDK sends them | |

There is no endpoint that lists sessions or replays per user except the replay search `query=user.id:<id>` (R1). That search is how Muninn builds a per-user history.
The `/organizations/{org}/members/` and `/users/` resources are **Sentry accounts** (org members), not end users of the customer's app. `viewed-by` returns those accounts.

**Muninn can use it for:** onboarding (list orgs and projects, show which have replays, read DSNs only if it must configure SDKs), and per-user replay history through the replay search.
