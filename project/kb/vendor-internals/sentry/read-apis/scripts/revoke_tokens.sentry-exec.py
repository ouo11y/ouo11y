"""Revoke the test tokens created by mint_tokens.sentry-exec.py (SELF-HOSTED, inside the web container).

  docker cp revoke_tokens.sentry-exec.py sentry-sbx-web-1:/tmp/revoke.py
  docker exec sentry-sbx-web-1 sentry exec /tmp/revoke.py

Matches by name prefix "step6-read-api" only. User tokens are deleted, org auth tokens are
deactivated (what the UI does), and the tokens of the internal integration's proxy user are deleted.
Delete the internal integration itself with: DELETE /api/0/sentry-apps/<slug>/ (org:admin token).
"""
from django.utils import timezone

from sentry.models.apitoken import ApiToken
from sentry.models.orgauthtoken import OrgAuthToken
from sentry.sentry_apps.models.sentry_app import SentryApp

n_user = ApiToken.objects.filter(name__startswith="step6-read-api").delete()[0]
n_org = 0
for t in OrgAuthToken.objects.filter(name__startswith="step6-read-api", date_deactivated__isnull=True):
    t.update(date_deactivated=timezone.now())
    n_org += 1
apps = list(SentryApp.objects.filter(slug__startswith="step6-read-api-muninn-probe"))
n_app = 0
for app in apps:
    n_app += ApiToken.objects.filter(user_id=app.proxy_user_id).delete()[0]
print(f"REVOKED user_tokens={n_user} org_tokens={n_org} app_tokens={n_app} apps={[a.slug for a in apps]}")
