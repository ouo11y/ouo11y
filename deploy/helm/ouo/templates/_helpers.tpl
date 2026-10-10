{{/*
Chart name.
*/}}
{{- define "ouo.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified release name. With release `ouo` and chart `ouo` this is `ouo`,
so the Services are ouo-rum-api, ouo-collector, ouo-grafana, ouo-loki, ouo-tempo, ouo-mimir.
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
Common labels. Call with (dict "root" $ "component" "rum-api").
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
Selector labels. Call with (dict "root" $ "component" "rum-api").
*/}}
{{- define "ouo.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ouo.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Component resource names */}}
{{- define "ouo.rumApi.fullname" -}}{{ include "ouo.fullname" . }}-rum-api{{- end -}}
{{- define "ouo.collector.fullname" -}}{{ include "ouo.fullname" . }}-collector{{- end -}}
{{- define "ouo.grafana.fullname" -}}{{ include "ouo.fullname" . }}-grafana{{- end -}}
{{- define "ouo.loki.fullname" -}}{{ include "ouo.fullname" . }}-loki{{- end -}}
{{- define "ouo.tempo.fullname" -}}{{ include "ouo.fullname" . }}-tempo{{- end -}}
{{- define "ouo.mimir.fullname" -}}{{ include "ouo.fullname" . }}-mimir{{- end -}}

{{/* Secret names (own or existing) */}}
{{- define "ouo.rumApi.secretName" -}}
{{- if .Values.rumApi.existingSecret -}}{{ .Values.rumApi.existingSecret }}{{- else -}}{{ include "ouo.rumApi.fullname" . }}{{- end -}}
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

{{/* In-cluster collector OTLP/HTTP endpoint */}}
{{- define "ouo.collectorOtlpHttp" -}}http://{{ include "ouo.collector.fullname" . }}:4318{{- end -}}

{{/* In-cluster rum-api URL (what the Grafana plugin proxies to) */}}
{{- define "ouo.rumApiUrl" -}}
{{- if .Values.grafana.plugin.rumApiUrl -}}{{ .Values.grafana.plugin.rumApiUrl }}{{- else -}}http://{{ include "ouo.rumApi.fullname" . }}:{{ .Values.rumApi.service.port }}{{- end -}}
{{- end -}}

{{/* Browser-facing Grafana URL for rum-api deep links */}}
{{- define "ouo.grafanaPublicUrl" -}}
{{- if .Values.rumApi.config.grafanaUrl -}}{{ .Values.rumApi.config.grafanaUrl | trimSuffix "/" }}
{{- else if .Values.grafana.rootUrl -}}{{ .Values.grafana.rootUrl | trimSuffix "/" }}
{{- else if .Values.grafana.ingress.enabled -}}{{ ternary "https" "http" .Values.grafana.ingress.tls.enabled }}://{{ .Values.grafana.ingress.host }}
{{- else -}}http://localhost:3000
{{- end -}}
{{- end -}}

{{/*
Validation: a project must be configured (ADR-0007: there is no auth-off mode).
*/}}
{{- define "ouo.validate" -}}
{{- if and (not .Values.projects) (not .Values.project.token) (not .Values.rumApi.existingSecret) -}}
{{- fail "ouo: set project.token (single project), projects (registry) or rumApi.existingSecret; rum-api refuses to start without a project (ADR-0007)" -}}
{{- end -}}
{{- if and .Values.grafana.enabled (not .Values.grafana.adminPassword) (not .Values.grafana.existingSecret) -}}
{{- fail "ouo: set grafana.adminPassword or grafana.existingSecret" -}}
{{- end -}}
{{- if not (has .Values.lgtm.mode (list "bundled" "external")) -}}
{{- fail (printf "ouo: lgtm.mode must be bundled or external, got %q" .Values.lgtm.mode) -}}
{{- end -}}
{{- end -}}
