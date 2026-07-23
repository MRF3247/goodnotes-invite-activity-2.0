# deploy-test workflow —— 测试 VKE helm 部署

手动触发的 Gitea Actions workflow（`.gitea/workflows/deploy-test.yaml`），在**集群内的 gitea runner** 上用 helm chart 把 invite-activity 部署到测试 VKE 的 `growth` namespace。

- 触发：Gitea → 本仓库 → Actions → `deploy-test` → Run workflow
- 唯一输入 `image`：**完整镜像名（含 tag）**，例：
  `goodnotes-cn-cn-shanghai.cr.volces.com/web/goodnotes-invite-activity:v1.0-20260707a`
- 流程：内部 clone → 写入 kubeconfig → `helm upgrade --install ... -f values-test.yaml --set image.repository/tag` → `rollout status`

镜像名会按最后一个 `:` 拆成 `image.repository` + `image.tag` 覆盖 chart 默认值；不含 tag 会直接失败。

## 认证：scoped kubeconfig（least-privilege）

凭据来自受限 SA `invite-activity-deployer`（`deploy/test-deployer-rbac.yaml`），权限被 Role **限死在 `growth` ns + 本 chart 用到的资源类型**。为它签一个长期 token，打包成 kubeconfig，base64 后存为 Gitea secret `KUBE_CONFIG_TEST`——**只有本仓库的 workflow 能读到**，不像 org 级 runner SA 那样对同 runner 的所有仓库开放。

## 一次性前置

```bash
# 本地 kubectl 已指向测试 VKE（context cd58un6vfi4sb52ojbeog@...）

# 1. 建部署身份（SA / Role / RoleBinding 全在 growth ns）
kubectl apply -f deploy/test-deployer-rbac.yaml

# 2. 生成 scoped kubeconfig
SA=invite-activity-deployer
SA_NS=growth
SECRET=invite-activity-deployer-token

#   2a. 绑定到 SA 的长期 token Secret（不会像 `kubectl create token` 那样过期）
kubectl apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: $SECRET
  namespace: $SA_NS
  annotations:
    kubernetes.io/service-account.name: $SA
type: kubernetes.io/service-account-token
EOF

#   2b. 取 API 地址 / CA / token 并拼 kubeconfig
#   ⚠️ server 必须用【集群内】kubernetes service 的 ClusterIP，不能用本地 kubeconfig 里的
#      公网 endpoint —— job 容器跑在集群内，公网 IP 从 pod 网络不可达（i/o timeout）。
#      集群 CA 的证书 SAN 覆盖该 ClusterIP，所以 TLS 校验正常。
SERVER="https://$(kubectl -n default get svc kubernetes -o jsonpath='{.spec.clusterIP}'):443"
CA=$(kubectl -n $SA_NS get secret $SECRET -o jsonpath='{.data.ca\.crt}')
TOKEN=$(kubectl -n $SA_NS get secret $SECRET -o jsonpath='{.data.token}' | base64 -d)
cat > /tmp/kubeconfig-scoped.yaml <<EOF
apiVersion: v1
kind: Config
clusters:
- name: test-vke
  cluster: { server: $SERVER, certificate-authority-data: $CA }
users:
- name: deployer
  user: { token: $TOKEN }
contexts:
- name: test-vke
  context: { cluster: test-vke, user: deployer, namespace: growth }
current-context: test-vke
EOF

#   2c. 验证 scope 真的生效（用 impersonation，不依赖 endpoint 可达性，本地即可跑）
SAUSER=system:serviceaccount:$SA_NS:$SA
kubectl auth can-i update deployments -n growth --as=$SAUSER   # yes
kubectl auth can-i list namespaces --as=$SAUSER                # no ✅
kubectl auth can-i get secrets -n kube-system --as=$SAUSER     # no ✅

#   2d. base64 存入 Gitea secret KUBE_CONFIG_TEST（仓库/组织 Settings → Actions → Secrets）
base64 -i /tmp/kubeconfig-scoped.yaml | pbcopy
rm /tmp/kubeconfig-scoped.yaml

# 3. 部署镜像 infra/helm-kubectl:3.16（含 git+helm+kubectl）——已构建并推到 CR，一次性：
#      docker build -t goodnotes-cn-cn-shanghai.cr.volces.com/infra/helm-kubectl:3.16 - <<'EOF'
#      FROM alpine/helm:3.16.2
#      RUN apk add --no-cache git kubectl bash
#      EOF
#    ve cr GetAuthorizationToken --Registry goodnotes-cn   # 取 docker login 凭据
#    docker push goodnotes-cn-cn-shanghai.cr.volces.com/infra/helm-kubectl:3.16
#
#    注：runner 已能自动认证拉取私有 CR 镜像（gitea-runner StatefulSet 的 runner+dind
#    容器把 cr-goodnotes-cn-cn-shanghai 以整目录挂到 /root/.docker，live 刷新），
#    无需手动预拉。镜像只要存在于 CR 即可。

# 4. growth ns 里前置资源（部署 chart 本身的前置，见 charts/invite-activity/README.md）
#    - sealed/test.sealedsecret.yaml 已 apply（提供 config.json 密钥）
#    - goodnotes-app-beta.cn-tls 通配证书已在 growth ns
```

## 排障

- 连不上 API（`dial tcp <公网IP>:6443: i/o timeout`）：kubeconfig 里的 `server` 用了公网 endpoint。job 容器在集群内，必须用 kubernetes service ClusterIP（`https://<clusterIP>:443`，见步骤 2b）。
- 镜像拉取 `unauthorized`：确认 runner+dind 的 `/root/.docker` 挂的是 `cr-auth`【整目录、非 subPath】（subPath 挂载不随 secret 刷新，token 会冻结过期）；镜像须已存在于 CR。
- helm RBAC forbidden：chart 新增了 `deploy/test-deployer-rbac.yaml` 未覆盖的资源类型，按报错补 Role 规则后重新 apply。
- token 失效：确认走的是 2a 的长期 token Secret 而非短期 `kubectl create token`。
- 镜像拉取失败：`infra/helm-kubectl:3.16` 未推到 CR（步骤 3）。
