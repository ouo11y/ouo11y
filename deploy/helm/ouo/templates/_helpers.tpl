{{/*
Chart name.
*/}}
{{- define "ouo.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified release name. With release `ouo` and chart `ouo` this is `ouo`,
so the Services are ouo-collector, ouo-grafana, ouo-loki, ouo-tempo, ouo-mimir.
*/}}
{{- define "ouo.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "ouo.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels. Call with (dict "root" $ "component" "collector").
*/}}
{{- define "ouo.labels" -}}
helm.sh/chart: {{ include "ouo.chart" .root }}
app.kubernetes.io/name: {{ include "ouo.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/part-of: ouo
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{- if .root.Chart.AppVersion }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
{{- end }}
{{- with .root.Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
Selector labels. Call with (dict "root" $ "component" "collector").
*/}}
{{- define "ouo.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ouo.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Component resource names */}}
{{- define "ouo.collector.fullname" -}}{{ include "ouo.fullname" . }}-collector{{- end -}}
{{- define "ouo.grafana.fullname" -}}{{ include "ouo.fullname" . }}-grafana{{- end -}}
{{- define "ouo.loki.fullname" -}}{{ include "ouo.fullname" . }}-loki{{- end -}}
{{- define "ouo.tempo.fullname" -}}{{ include "ouo.fullname" . }}-tempo{{- end -}}
{{- define "ouo.mimir.fullname" -}}{{ include "ouo.fullname" . }}-mimir{{- end -}}

{{/* Secret names (own or existing) */}}
{{- define "ouo.muninn.secretName" -}}
{{- if .Values.muninn.existingSecret -}}{{ .Values.muninn.existingSecret }}{{- else -}}{{ include "ouo.collector.fullname" . }}-muninn{{- end -}}
{{- end -}}
{{- define "ouo.grafana.secretName" -}}
{{- if .Values.grafana.existingSecret -}}{{ .Values.grafana.existingSecret }}{{- else -}}{{ include "ouo.grafana.fullname" . }}{{- end -}}
{{- end -}}

{{/* Image reference. Call with .Values.<component>.image */}}
{{- define "ouo.image" -}}
{{- printf "%s:%s" .repository (toString .tag) -}}
{{- end -}}

{{/*
LGTM endpoints. Bundled mode points at the chart's own Services; external mode at
.Values.lgtm.external.* with the derived defaults documented in values.yaml.
*/}}
{{- define "ouo.lgtm.bundled" -}}{{- if eq .Values.lgtm.mode "bundled" -}}true{{- end -}}{{- end -}}

{{- define "ouo.lokiUrl" -}}
{{- if include "ouo.lgtm.bundled" . -}}http://{{ include "ouo.loki.fullname" . }}:3100{{- else -}}{{ required "lgtm.external.lokiUrl is required in external mode" .Values.lgtm.external.lokiUrl | trimSuffix "/" }}{{- end -}}
{{- end -}}

{{- define "ouo.lokiOtlpUrl" -}}
{{- if include "ouo.lgtm.bundled" . -}}http://{{ include "ouo.loki.fullname" . }}:3100/otlp{{- else if .Values.lgtm.external.lokiOtlpUrl -}}{{ .Values.lgtm.external.lokiOtlpUrl | trimSuffix "/" }}{{- else -}}{{ include "ouo.lokiUrl" . }}/otlp{{- end -}}
{{- end -}}

{{- define "ouo.tempoUrl" -}}
{{- if include "ouo.lgtm.bundled" . -}}http://{{ include "ouo.tempo.fullname" . }}:3200{{- else -}}{{ required "lgtm.external.tempoUrl is required in external mode" .Values.lgtm.external.tempoUrl | trimSuffix "/" }}{{- end -}}
{{- end -}}

{{- define "ouo.tempoOtlpGrpcEndpoint" -}}
{{- if include "ouo.lgtm.bundled" . -}}{{ include "ouo.tempo.fullname" . }}:4317{{- else -}}{{ required "lgtm.external.tempoOtlpGrpcEndpoint is required in external mode" .Values.lgtm.external.tempoOtlpGrpcEndpoint }}{{- end -}}
{{- end -}}

{{- define "ouo.mimirUrl" -}}
{{- if include "ouo.lgtm.bundled" . -}}http://{{ include "ouo.mimir.fullname" . }}:9009{{- else -}}{{ required "lgtm.external.mimirUrl is required in external mode" .Values.lgtm.external.mimirUrl | trimSuffix "/" }}{{- end -}}
{{- end -}}

{{- define "ouo.mimirOtlpUrl" -}}
{{- if include "ouo.lgtm.bundled" . -}}http://{{ include "ouo.mimir.fullname" . }}:9009/otlp{{- else if .Values.lgtm.external.mimirOtlpUrl -}}{{ .Values.lgtm.external.mimirOtlpUrl | trimSuffix "/" }}{{- else -}}{{ include "ouo.mimirUrl" . }}/otlp{{- end -}}
{{- end -}}

{{- define "ouo.mimirPrometheusUrl" -}}
{{- if include "ouo.lgtm.bundled" . -}}http://{{ include "ouo.mimir.fullname" . }}:9009/prometheus{{- else if .Values.lgtm.external.mimirPrometheusUrl -}}{{ .Values.lgtm.external.mimirPrometheusUrl | trimSuffix "/" }}{{- else -}}{{ include "ouo.mimirUrl" . }}/prometheus{{- end -}}
{{- end -}}

{{/* Collector resource names and in-cluster endpoints */}}
{{- define "ouo.collector.internalName" -}}{{ include "ouo.collector.fullname" . }}-internal{{- end -}}
{{- define "ouo.collector.projectsSecretName" -}}
{{- if .Values.collector.existingProjectsSecret -}}{{ .Values.collector.existingProjectsSecret }}{{- else -}}{{ include "ouo.collector.fullname" . }}-projects{{- end -}}
{{- end -}}
{{/* X-Scope-OrgID on the collector exporters in external multi-tenant mode */}}
{{- define "ouo.tenantHeaders" -}}
{{- if and (eq .Values.lgtm.mode "external") .Values.lgtm.external.tenantId }}
headers:
  X-Scope-OrgID: {{ .Values.lgtm.external.tenantId | quote }}
{{- end }}
{{- end -}}
{{/* Client key of the ouoratelimit client bucket */}}
{{- define "ouo.rateLimitClientKey" -}}
{{- if .Values.collector.rateLimit.client.keyFrom -}}{{ .Values.collector.rateLimit.client.keyFrom }}{{- else if .Values.collector.ingress.enabled -}}x_forwarded_for{{- else -}}address{{- end -}}
{{- end -}}
{{/* Public collector base URL (Ingress) or the port-forward default */}}
{{- define "ouo.collectorPublicUrl" -}}
{{- if .Values.collector.ingress.enabled -}}{{ ternary "https" "http" .Values.collector.ingress.tls.enabled }}://{{ .Values.collector.ingress.host }}{{- else -}}http://localhost:4318{{- end -}}
{{- end -}}

{{/*
Validation: a project must be configured (ADR-0007: there is no auth-off mode).
*/}}
{{- define "ouo.validate" -}}
{{- if and .Values.collector.enabled (not .Values.projects) (not .Values.collector.existingProjectsSecret) -}}
{{- fail "ouo: set projects (list of {id, token}) or collector.existingProjectsSecret; the collector refuses every ingest request without a project (ADR-0007)" -}}
{{- end -}}
{{- $seen := dict -}}
{{- range .Values.projects -}}
{{- if hasKey $seen (toString .id) -}}
{{- fail (printf "ouo: project id %q appears twice in projects. The collector's basicauth (htpasswd) keeps only the LAST line per username, so the earlier token would silently stop working (verified on kind, see project/kb-archive/helm-kind.md). Rotate by replacing the token in place" (toString .id)) -}}
{{- end -}}
{{- $_ := set $seen (toString .id) true -}}
{{- if or (not .id) (not .token) -}}
{{- fail "ouo: every entry of projects needs a non-empty id and token" -}}
{{- end -}}
{{- if not (regexMatch "^[a-z0-9][a-z0-9._-]{0,63}$" (toString .id)) -}}
{{- fail (printf "ouo: project id %q must match ^[a-z0-9][a-z0-9._-]{0,63}$ (Muninn and Loki labels use it; ':' would break htpasswd)" (toString .id)) -}}
{{- end -}}
{{- end -}}
{{- if and .Values.grafana.enabled (not .Values.grafana.adminPassword) (not .Values.grafana.existingSecret) -}}
{{- fail "ouo: set grafana.adminPassword or grafana.existingSecret" -}}
{{- end -}}
{{- if and .Values.collector.enabled (not .Values.muninn.endpoint) -}}
{{- fail "ouo: set muninn.endpoint (the Muninn base URL the collector sends replay chunks to, ADR-0019); this chart does not deploy Muninn" -}}
{{- end -}}
{{- if and .Values.collector.enabled (not .Values.muninn.ingestToken) (not .Values.muninn.existingSecret) -}}
{{- fail "ouo: set muninn.ingestToken (Muninn's auth.ingest_token) or muninn.existingSecret" -}}
{{- end -}}
{{- range $id, $p := .Values.retention.projects -}}
{{- if not (regexMatch "^[a-z0-9][a-z0-9._-]{0,63}$" (toString $id)) -}}
{{- fail (printf "ouo: retention.projects key %q is not a project id" (toString $id)) -}}
{{- end -}}
{{- end -}}
{{- if not (has .Values.lgtm.mode (list "bundled" "external")) -}}
{{- fail (printf "ouo: lgtm.mode must be bundled or external, got %q" .Values.lgtm.mode) -}}
{{- end -}}
{{- end -}}

{{/*
htpasswd `{SHA}` digest of a token: base64 of the raw 20-byte SHA-1. Sprig's sha1sum
returns hex and has no hex decoder, so the hex is converted to a bit string and
re-grouped into base64 sextets here (160 bits + 2 zero bits = 27 characters + one "=").
Cheap on purpose: the collector verifies it on every request and the token is a public
identifier (ADR-0007 section 2); bcrypt is not acceptable at ingest rates.
*/}}
{{- define "ouo.htpasswdSha" -}}
{{- $hex := sha1sum . -}}
{{- $nib := dict "0" "0000" "1" "0001" "2" "0010" "3" "0011" "4" "0100" "5" "0101" "6" "0110" "7" "0111" "8" "1000" "9" "1001" "a" "1010" "b" "1011" "c" "1100" "d" "1101" "e" "1110" "f" "1111" -}}
{{- $bits := "" -}}
{{- range $i := until 40 -}}
{{- $bits = printf "%s%s" $bits (index $nib (substr $i (add1 $i | int) $hex)) -}}
{{- end -}}
{{- $bits = printf "%s00" $bits -}}
{{- $alpha := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/" -}}
{{- $out := "" -}}
{{- range $i := until 27 -}}
{{- $chunk := substr (mul $i 6 | int) (mul (add1 $i) 6 | int) $bits -}}
{{- $v := 0 -}}
{{- range $j := until 6 -}}
{{- $v = add (mul $v 2) (substr $j (add1 $j | int) $chunk | atoi) | int -}}
{{- end -}}
{{- $out = printf "%s%s" $out (substr $v (add1 $v | int) $alpha) -}}
{{- end -}}
{{- printf "{SHA}%s=" $out -}}
{{- end -}}

{{/* The htpasswd file: one line per project entry */}}
{{- define "ouo.projectsHtpasswd" -}}
{{- range .Values.projects -}}
{{ .id }}:{{ include "ouo.htpasswdSha" .token }}
{{ end -}}
{{- end -}}
