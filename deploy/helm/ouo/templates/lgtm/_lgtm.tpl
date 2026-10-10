{{/*
Shared StatefulSet for the bundled single-binary Loki / Tempo / Mimir.
Call with (dict "root" $ "component" "loki" "values" .Values.lgtm.bundled.loki
           "name" <fullname> "mountPath" "/loki" "configPath" "/etc/loki/config.yaml"
           "ports" (list (dict "name" "http" "port" 3100) ...) "readyPort" "http")
*/}}
{{- define "ouo.lgtm.statefulset" -}}
{{- $v := .values -}}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ .name }}
  labels:
    {{- include "ouo.labels" (dict "root" .root "component" .component) | nindent 4 }}
spec:
  replicas: 1
  serviceName: {{ .name }}
  selector:
    matchLabels:
      {{- include "ouo.selectorLabels" (dict "root" .root "component" .component) | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "ouo.selectorLabels" (dict "root" .root "component" .component) | nindent 8 }}
      annotations:
        checksum/config: {{ include (printf "%s/lgtm/%s-configmap.yaml" .root.Template.BasePath .component) .root | sha256sum }}
        {{- with $v.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
    spec:
      {{- with .root.Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      securityContext:
        {{- toYaml $v.podSecurityContext | nindent 8 }}
      containers:
        - name: {{ .component }}
          image: {{ include "ouo.image" $v.image }}
          imagePullPolicy: {{ $v.image.pullPolicy }}
          args: ["-config.file={{ .configPath }}"]
          ports:
            {{- range .ports }}
            - name: {{ .name }}
              containerPort: {{ .port }}
              protocol: TCP
            {{- end }}
          volumeMounts:
            - name: config
              mountPath: {{ dir .configPath }}
              readOnly: true
            - name: data
              mountPath: {{ .mountPath }}
          readinessProbe:
            httpGet:
              path: /ready
              port: {{ .readyPort }}
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 36
          livenessProbe:
            httpGet:
              path: /ready
              port: {{ .readyPort }}
            initialDelaySeconds: 120
            periodSeconds: 20
            failureThreshold: 6
          resources:
            {{- toYaml $v.resources | nindent 12 }}
      volumes:
        - name: config
          configMap:
            name: {{ .name }}
        {{- if not $v.persistence.enabled }}
        - name: data
          emptyDir: {}
        {{- end }}
      {{- with $v.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $v.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $v.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
  {{- if $v.persistence.enabled }}
  # PVCs created by a StatefulSet survive `helm uninstall`; delete them to drop the data.
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes:
          {{- toYaml $v.persistence.accessModes | nindent 10 }}
        {{- with $v.persistence.storageClass }}
        storageClassName: {{ . | quote }}
        {{- end }}
        resources:
          requests:
            storage: {{ $v.persistence.size }}
  {{- end }}
{{- end -}}

{{- define "ouo.lgtm.service" -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ .name }}
  labels:
    {{- include "ouo.labels" (dict "root" .root "component" .component) | nindent 4 }}
spec:
  type: ClusterIP
  ports:
    {{- range .ports }}
    - name: {{ .name }}
      port: {{ .port }}
      targetPort: {{ .name }}
      protocol: TCP
    {{- end }}
  selector:
    {{- include "ouo.selectorLabels" (dict "root" .root "component" .component) | nindent 4 }}
{{- end -}}
