# 本仓库 Gitea 使用说明（操作手册）

自建 Gitea：`https://git-corp.goodnotes-app-beta.cn`（组织 `Goodnotes-CN`）。`gh` 用不了，PR/操作走 Gitea Web 或 `tea` CLI / REST API。

---

## 1. 分支保护：`main` 不能直接推送

`main` 已开启分支保护，**禁止 `git push` 直推**（直推会被拒）。任何更新都必须走 **Pull Request 合并**。

标准改动流程：

```bash
git checkout main && git pull
git checkout -b <你的分支>          # 从最新 main 切分支
# ... 改动 ...
git commit -m "..."
git push -u origin <你的分支>       # 推分支（不是 main）
```

然后在 Gitea 上对该分支开 PR → base 选 `main`。

## 2. PR 审批规则

- **至少需要 1 个人 approve** 才能合并。
- **PR 提交人 ≠ approve 人**：Gitea 不允许给自己的 PR 投 approve，所以必须由**另一个人**审核通过。
- approve 后，在 PR 页面点 **Merge**（或让审核人合并）。合并后删掉分支即可。

> 因此：自己一个人无法闭环合并，务必找一位同事 review。

## 3. 工作流（Gitea Actions）

Runner 部署在测试 VKE 集群内（org 级，label `ubuntu-latest`）。两个工作流都在 `.gitea/workflows/` 下。

**操作入口（手动触发）**：Gitea → 本仓库 → 顶部 **Actions** 标签 → 左侧选择对应工作流 → 右上 **Run workflow** → 选分支（/填参数）→ 运行。

### 3.1 `build-image.yaml`：构建并推送镜像

把代码打成 Docker 镜像推到火山云 CR（`goodnotes-cn-cn-shanghai.cr.volces.com/web/goodnotes-invite-activity`）。

**触发方式**
- **自动**：推送 `v*` 标签时触发。例：
  ```bash
  git tag v1.0-20260708a && git push origin v1.0-20260708a
  ```
- **手动**：Actions → `build-image` → Run workflow → 选分支运行（**无需填任何参数**）。

**产出的镜像 tag**（自动生成，无需手填）
| 场景 | 推送的 tag |
|---|---|
| 手动 / 普通分支构建 | `提交日期-shortsha`（如 `20260708-abc1234`）、`shortsha`（如 `abc1234`） |
| 推送 `v*` 标签（release） | 上述两个 + **标签名**（如 `v1.0-20260708a`）+ `latest` |

> 用「提交日期」而非构建日期：同一 commit 重建得到相同 tag。手动构建**不会**动 `latest`。

结束后向飞书群发送构建结果卡片（含镜像、commit、作者、run 链接）。

### 3.2 `deploy-test.yaml`：部署到测试环境

用 Helm chart 把指定镜像部署到**测试 VKE** 的 `growth` namespace。

**触发方式**：仅**手动**。Actions → `deploy-test` → Run workflow → 在 **`image`** 输入框填**完整镜像名（含 tag）**，例：

```
goodnotes-cn-cn-shanghai.cr.volces.com/web/goodnotes-invite-activity:20260708-abc1234
```

（tag 可用 3.1 里 build-image 产出的任意一个）

**行为**
- `helm upgrade --install invite-activity -n growth -f values-test.yaml --set image...`，等待 rollout。
- run 页面末尾的 `Job summary` 步骤里有部署摘要（状态 / 镜像 / revision / pods）。
- 结束后向飞书群发送部署结果卡片。

**前置（已配置好，日常无需管）**：受限 SA 的 scoped kubeconfig 存于 repo secret `KUBE_CONFIG_TEST`；密钥 SealedSecret 与 TLS 证书已在 `growth` ns。详见 [deploy-test-workflow.md](deploy-test-workflow.md)。

---

## 典型流程串起来

1. 改代码 → 开 PR → 同事 approve → 合并到 `main`。
2. 需要镜像：手动跑 `build-image`（或推 `v*` 标签），记下产出的镜像 tag。
3. 部署测试：手动跑 `deploy-test`，`image` 填上一步的完整镜像名。
4. 看飞书群通知 + run 页面确认结果。
