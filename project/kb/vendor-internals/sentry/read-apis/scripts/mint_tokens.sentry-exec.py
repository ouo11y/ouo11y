"""Mint narrow-scope test tokens on a SELF-HOSTED Sentry (run inside the web container).

  docker cp mint_tokens.sentry-exec.py sentry-sbx-web-1:/tmp/mint.py
  docker exec sentry-sbx-web-1 sentry exec /tmp/mint.py | grep '^JSON' | sed 's/^JSON//' > tokens.json

Prints the token values once (JSON on a line starting with "JSON"). Keep them out of git.
Revoke with revoke_tokens.sentry-exec.py. Admin user email and org slug are local defaults.
"""
import json
from sentry.models.apitoken import ApiToken
from sentry.models.orgauthtoken import OrgAuthToken
from sentry.users.models.user import User
from sentry.models.organization import Organization
from sentry.utils.security.orgauthtoken_token import generate_token, hash_token
from sentry.silo.base import SiloMode
u=User.objects.get(email="admin@ouo.localhost"); org=Organization.objects.get(slug="sentry")
sets={"u_org_read":["org:read"],"u_project_read":["project:read"],"u_event_read":["event:read"],"u_muninn":["org:read","project:read","event:read"],"u_team_read":["team:read"]}
out={}
for name,sc in sets.items():
    t=ApiToken.objects.create(user_id=u.id,scope_list=sc,name="step6-read-api "+name)
    out[name]={"id":t.id,"token":t.token,"scopes":sc,"kind":"user"}
for name,sc in {"o_ci":["org:ci"],"o_event_org_read":["org:read","event:read"],"o_muninn":["org:read","project:read","event:read"]}.items():
    tok=generate_token(org.slug,"http://localhost:9000")
    o=OrgAuthToken.objects.create(organization_id=org.id,name="step6-read-api "+name,scope_list=sc,token_hashed=hash_token(tok),token_last_characters=tok[-4:],created_by_id=u.id)
    out[name]={"id":o.id,"token":tok,"scopes":sc,"kind":"org"}
print("JSON"+json.dumps(out))
