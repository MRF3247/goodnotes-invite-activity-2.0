# Docker 镜像构建的 Gitea Actions 工作流化 — 设计

日期: 2026-07-07

## 目的

把 `goodnotes-invite-activity` 的 Docker 镜像构建从手工操作迁移到 Gitea Actions 工作流。自动化到「构建并 push 到 Volcengine CR」为止（VKE 部署不在范围内）。

## 运行环境

- Gitea: 自托管 `git-corp.goodnotes-app-beta.cn`（1.25.5，已启用 Actions）
- Runner: 测试 VKE 的 `gitea-runner` ns，已注册到 org `Goodnotes-CN`。act_runner + `docker:27-dind` sidecar（同一 Pod、共享 netns、`tcp://localhost:2375`）。labels `vke / linux_amd64 / ubuntu-latest`。
- 节点为 amd64 / containerd。无法直连 docker.io（CN 网），镜像统一走 CR。

## 决策事项

| 项目 | 决策 |
|---|---|
| 触发条件 | `push: tags: ['v*']`（仅在 push 标签时） |
| push 目标 | `goodnotes-cn-cn-shanghai.cr.volces.com/web/goodnotes-invite-activity` |
| 镜像标签 | ① git 标签名（例 `v1.0-20260707a`）② git 短 SHA ③ `latest` |
| 范围 | 构建 + push 到 CR 为止 |
| CR 认证 | 把 `ve cr SetUser` 的长期密码存入 Gitea org secret（`CR_USERNAME`/`CR_PASSWORD`），再 `docker login` |

## 技术构成

### CI job 用镜像（新增）
`actions/checkout` 等 JS action 需要 node，但 act_runner 本体(alpine)和 `docker:dind` 都没有 node，同时还需要 docker CLI。因此单独做一个专用镜像：

```dockerfile
FROM node:22-bookworm  # 自带 node + git
COPY --from=goodnotes-cn-cn-shanghai.cr.volces.com/infra/docker:27-dind \
     /usr/local/bin/docker /usr/local/bin/docker
```
→ `goodnotes-cn-cn-shanghai.cr.volces.com/infra/ci-node-docker:22`（在 Mac 上构建后 push）。运行时不访问 docker.io，因此在 CN 网也稳定。

### 工作流（`.gitea/workflows/build-image.yaml`）
```yaml
on: { push: { tags: ['v*'] } }
jobs:
  build:
    runs-on: ubuntu-latest
    container:
      image: goodnotes-cn-cn-shanghai.cr.volces.com/infra/ci-node-docker:22
      options: --network host          # 为了经 localhost:2375 访问 sidecar dind
    env: { DOCKER_HOST: 'tcp://localhost:2375' }
    steps:
      - uses: actions/checkout@v4
      - docker login (secrets.CR_USERNAME / CR_PASSWORD)
      - docker build --platform linux/amd64 -t <3 个标签> .
      - docker push (×3)
```

- `--network host`: 把 job 容器挂到 dind 的 netns(=Pod netns) 上，从而经 `localhost:2375` 到达 sidecar dind。
- amd64 原生构建，无需 buildx。

## 已知风险 / 待验证项

1. **act_runner 是否允许 job 的 `container.options: --network host`**。取决于默认配置。若不允许，需在 runner 的 config.yaml 里放开 `container.options`，或把 dind 独立成 Service。→ 先用一个小 workflow 做连通性验证。
2. CR 长期密码的权限（对 web namespace 的 push 权限）。
3. Dockerfile 必须包含在被打标签的 commit 里（当前在 `add-dockerfile` 分支，前提是合并 main 后再打标签）。

## 不做（YAGNI）

- 自动部署到 VKE（K8s manifest 另行处理，尚未创建）
- multi-arch 构建（节点只有 amd64）
- PR/main push 触发
