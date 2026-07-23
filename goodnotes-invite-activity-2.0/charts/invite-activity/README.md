# invite-activity Helm chart

Goodnotes极速版 邀请活动服务的 VKE 部署 chart。**有状态**：单进程 Node.js + 本地 SQLite（WAL）+ 进程内每日刷榜任务 —— 因此 **replicas 固定 1、strategy 固定 Recreate，切勿扩副本或改 RollingUpdate**（两副本会损坏数据库并重复刷榜）。

## 组成

| 资源 | 说明 |
|---|---|
| Deployment | replicas:1 / Recreate；挂 PVC→`/data`，挂 config Secret→`/app/config.json`（subPath）；探针 `GET /` |
| Service | ClusterIP `80 → 3210` |
| Ingress | prod `invite.goodnotes-app.cn` / test `invite.goodnotes-app-beta.cn`，ingressClass `nginx`，复用通配证书 |
| PVC | `ebs-ssd` / RWO / 20Gi |

密钥（`config.json`，含 adminToken/secret）**不由 helm 管理**，走 SealedSecret（见下），部署前先 `kubectl apply`。

## 环境

| env | 集群 | 访问 kubectl | namespace | host | TLS secret | seal 方式 |
|---|---|---|---|---|---|---|
| test | 测试 VKE | 本地 kubectl 当前 context | growth | invite.goodnotes-app-beta.cn | goodnotes-app-beta.cn-tls | 直连控制器 `./seal.sh test` |
| prod | 生产 VKE | JumpServer | growth | invite.goodnotes-app.cn | goodnotes-app.cn-tls | 离线 `SEALED_CERT=... ./seal.sh prod` |

test 用 `-f values-test.yaml` 覆盖；prod 用 values.yaml 默认值。

## 部署步骤（测试环境 / 测试 VKE / namespace growth）

```bash
cd charts/invite-activity

# 1. 明文密钥源（gitignored）
cp values-prod.local.yaml.example values-test.local.yaml
#    填入随机 adminToken / secret（node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))" 等）

# 2. 封装（本地 kubectl 已指向测试集群，直连控制器，无需 cert）
./seal.sh test                         # 产出 sealed/test.sealedsecret.yaml

# 3. 命名空间 + 证书 + 密钥
kubectl create namespace growth
kubectl get secret goodnotes-app-beta.cn-tls -n goodnotes-test -o yaml \
  | sed 's/namespace: goodnotes-test/namespace: growth/' \
  | kubectl apply -n growth -f -        # 拷贝通配证书到 growth
kubectl apply -f sealed/test.sealedsecret.yaml

# 4. 安装
helm upgrade --install invite-activity . -n growth -f values-test.yaml
```

## 部署步骤（prod / namespace: growth）

```bash
cd charts/invite-activity

# 1. 准备明文密钥源（gitignored）
cp values-prod.local.yaml.example values-prod.local.yaml
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"  # 填 adminToken
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"        # 填 secret
# 编辑 values-prod.local.yaml 填入上面两个值

# 2. 取一次集群 sealed-secrets 公钥证书（prod 走 jumpserver，用 k8s-prod skill）：
#      kubeseal --controller-namespace kube-system --controller-name sealed-secrets --fetch-cert
#    把输出保存为本地 /tmp/prod-sealed.crt

# 3. 封装 config.json 为 SealedSecret（离线）
SEALED_CERT=/tmp/prod-sealed.crt ./seal.sh
#    产出 sealed/growth.sealedsecret.yaml（加密，可入库）

# 4. 应用密钥（走 jumpserver kubectl）
kubectl apply -f charts/invite-activity/sealed/growth.sealedsecret.yaml

# 5. 确认 TLS 证书存在于 growth ns（从 goodnotes-prod ns 拷贝通配证书，与 redeem 同）

# 6. 安装/升级
helm upgrade --install invite-activity charts/invite-activity -n growth
```

## 升级镜像

```bash
helm upgrade invite-activity charts/invite-activity -n growth --set image.tag=v1.0-YYYYMMDDx
```

## 注意

- 改 `namespace` 或 `config.secretName` 需**重新 seal**（SealedSecret 密文绑定 name+namespace，strict scope）。
- 数据全在 PVC 的 `data.db` 一个文件里，需定期备份（VKE 磁盘快照或 CronJob）。
- 更新版本切勿删 PVC。
