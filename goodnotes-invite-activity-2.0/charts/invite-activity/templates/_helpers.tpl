{{- define "invite-activity.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "invite-activity.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "invite-activity.name" . | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "invite-activity.labels" -}}
app.kubernetes.io/name: {{ include "invite-activity.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app: {{ include "invite-activity.name" . }}
{{- end -}}

{{- define "invite-activity.selectorLabels" -}}
app: {{ include "invite-activity.name" . }}
{{- end -}}
