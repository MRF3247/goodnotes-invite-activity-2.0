#!/usr/bin/env bash
# 把 config.json 封成可入库的 SealedSecret（sealed/<env>.sealedsecret.yaml）。
#
# 读 gitignored 的明文 values-<env>.local.yaml 里的 `config:` 字段，渲染成 config.json，
# 构建一个 K8s Secret（key=config.json），交给 kubeseal（strict scope）加密。产物加密后
# 可安全入库，只有目标集群的 sealed-secrets 控制器能解密。
#
# 两个环境都部署在 namespace `growth`，但分属不同集群（不同 sealed-secrets 控制器/证书），
# 因此密文按 env 区分：sealed/test.sealedsecret.yaml、sealed/prod.sealedsecret.yaml。
#
# 用法：
#   ./seal.sh test          # 本地 kubectl 已指向测试集群 → 直连控制器封装
#   SEALED_CERT=/tmp/prod-sealed.crt ./seal.sh prod
#                           # prod 只能走 jumpserver，先取 cert 再离线封装：
#                           #   （jumpserver 上）kubeseal --controller-namespace kube-system \
#                           #       --controller-name sealed-secrets --fetch-cert > /tmp/prod-sealed.crt
#
# 之后：kubectl apply -f charts/invite-activity/sealed/<env>.sealedsecret.yaml
set -euo pipefail

CHART_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRET_NAME="${SECRET_NAME:-invite-activity-config}"
NS="${NS:-growth}"
CONTROLLER_NS="${SEALED_CONTROLLER_NS:-kube-system}"
CONTROLLER_NAME="${SEALED_CONTROLLER_NAME:-sealed-secrets}"

ENV="${1:-}"
case "$ENV" in
  test|prod) : ;;
  *) echo "usage: $0 {test|prod}" >&2; exit 2 ;;
esac
LOCAL_PATH="${LOCAL_PATH:-${CHART_DIR}/values-${ENV}.local.yaml}"
OUT="${CHART_DIR}/sealed/${ENV}.sealedsecret.yaml"

[[ -f "$LOCAL_PATH" ]] || { echo "ERROR: 缺少明文源 $LOCAL_PATH（从 values-prod.local.yaml.example 复制并填值）" >&2; exit 1; }
command -v kubeseal >/dev/null || { echo "ERROR: 未安装 kubeseal（brew install kubeseal）" >&2; exit 1; }
mkdir -p "${CHART_DIR}/sealed"

if [[ -n "${SEALED_CERT:-}" ]]; then
  [[ -f "$SEALED_CERT" ]] || { echo "ERROR: SEALED_CERT 文件不存在: $SEALED_CERT" >&2; exit 1; }
  echo "[$ENV] 封装模式：离线 cert ($SEALED_CERT)"
else
  echo "[$ENV] 封装模式：直连控制器 ${CONTROLLER_NS}/${CONTROLLER_NAME} (context: $(kubectl config current-context 2>/dev/null || echo '?'))"
fi

SECRET_NAME="$SECRET_NAME" NS="$NS" LOCAL_PATH="$LOCAL_PATH" OUT="$OUT" \
CONTROLLER_NS="$CONTROLLER_NS" CONTROLLER_NAME="$CONTROLLER_NAME" SEALED_CERT="${SEALED_CERT:-}" \
python3 - <<'PY'
import os, sys, json, yaml, subprocess

vals = yaml.safe_load(open(os.environ['LOCAL_PATH'])) or {}
cfg = vals.get('config')
if not cfg:
    print("ERROR: values-<env>.local.yaml 里没有 `config:` 段", file=sys.stderr); sys.exit(1)
for k in ('adminToken', 'secret'):
    if not cfg.get(k) or str(cfg[k]).startswith('REPLACE_ME'):
        print(f"ERROR: config.{k} 还是占位符，请填真实随机值", file=sys.stderr); sys.exit(1)

# 渲染 config.json（app 直接读这个文件）
config_json = json.dumps({
    'port':       int(cfg.get('port', 3210)),
    'adminToken': str(cfg['adminToken']),
    'secret':     str(cfg['secret']),
    'dataDir':    str(cfg.get('dataDir', '/data')),
}, ensure_ascii=False, indent=2)

manifest = {
    'apiVersion': 'v1', 'kind': 'Secret',
    'metadata': {'name': os.environ['SECRET_NAME'], 'namespace': os.environ['NS'],
                 'labels': {'app.kubernetes.io/name': 'invite-activity'}},
    'type': 'Opaque',
    'stringData': {'config.json': config_json},
}
plaintext = yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True)

args = ['kubeseal', '--format', 'yaml', '--scope', 'strict']
if os.environ.get('SEALED_CERT'):
    args += ['--cert', os.environ['SEALED_CERT']]
else:
    args += ['--controller-namespace', os.environ['CONTROLLER_NS'],
             '--controller-name', os.environ['CONTROLLER_NAME']]

p = subprocess.run(args, input=plaintext, capture_output=True, text=True)
if p.returncode != 0:
    print("kubeseal 失败:", p.stderr[:500], file=sys.stderr); sys.exit(1)
open(os.environ['OUT'], 'w').write(p.stdout)
print(f"  已封装 -> sealed/{os.path.basename(os.environ['OUT'])} (Secret={os.environ['SECRET_NAME']}, ns={os.environ['NS']}, key=config.json)")
PY

echo "完成。审阅并提交 sealed/${ENV}.sealedsecret.yaml，然后："
echo "  kubectl apply -f charts/invite-activity/sealed/${ENV}.sealedsecret.yaml"
