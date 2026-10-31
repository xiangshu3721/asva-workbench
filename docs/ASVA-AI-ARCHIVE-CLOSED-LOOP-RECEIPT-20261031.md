# ASVA｜AI 自动归档完整闭环 RECEIPT

- 时间：2026-10-31（Asia/Shanghai）
- 架构选择：**A — 独立普通云函数 worker `asva-ai-archive`**（个人版可建；异步 SCF Invoke Event；无固定升配；勿开预置并发）
- 起点 tip：`e3853c2c0f0dc8adbdedf6dfb96256d0e9b7aa89`
- 分支：`fix/ai-archive-closed-loop-20261031`
- **后端 tip SHA**：`405016d0a9f2b14892f894373954a918708889d2`
- **未部署、未写生产飞书、未批量恢复/改生产客户、未 merge dirty PR#54**

## 架构

```
导师保存客户
  → asva-api(HTTP)：持久化原文 + `_automatic_profile_pending` + 快速 2xx（≤8s；AI 失败不拖垮保存）
  → scheduleAutomaticCustomerProfile
       · 异步 Event Invoke → asva-ai-archive（主路径）
       · 同实例 best-effort createSource（kickoff ≤2s，仅加速读回）
  → worker：recover by customerId → ensure Source → processSource
       → Evidence + Customers 结构化 + proposals/待核实
  → 兜底：GET /profile 按 SourceRecords/pending 单客户 resume；ADMIN recover-automatic-processing?customerId=
```

明确禁止：同函数 `send(201)` 后 `void processSource`（已从 `server/index.mjs` 移除）。

状态映射（`autoOrganizeStatus`，最小扩展）：

| 业务 | 来源 |
| --- | --- |
| 待处理 PENDING | pending 有、尚无 Source |
| 处理中 PROCESSING | Source UPLOADED/PROCESSING |
| 已完成 COMPLETED | Source COMPLETED + 可用 Evidence |
| 待核实 REVIEW_REQUIRED | Source REVIEW_REQUIRED |
| 失败 FAILED | Source FAILED |
| 无可用输出 NO_USABLE_OUTPUT | COMPLETED 但无可用 Evidence |

## 变更文件清单

### 后端（本分支）

- `server/ai-archive-invoke.mjs` — SCF Event Invoke / local worker 双模式
- `server/ai-archive-worker.mjs` — Event 云函数入口，复用 recover/processSource
- `server/repository.mjs` — schedule* 改走 worker；pending→PENDING 状态
- `server/index.mjs` — 去掉 send 后 void processSource
- `server/config.mjs` — aiArchive 配置段
- `server/ai-archive-closed-loop.test.mjs` — HTTP A–G 验收
- `server/automatic-processing-recovery-path.test.mjs` — 断言更新
- `server/automatic-profile-processing.test.mjs` — 断言更新
- `scripts/build-cloudbase-ai-archive.mjs` — worker 打包
- `scripts/deploy-cloudbase.mjs` — 部署 worker（Event, memory=512, timeout=120）
- `package.json` — `build:cloudbase` 含 worker
- `.env.example` — worker/Invoke 变量说明
- `.gitignore` — 忽略 worker bundle
- `cloudbase/functions/asva-ai-archive/package.json` — CJS 包元数据

### 前端

- **无独立前端 PR**：正式 master 已含 `autoOrganizeStatus` 展示（AI整理中/失败/待核实/完成/等待恢复）。本轮后端状态字段与之对齐；勿用 dirty PR#54 前端覆盖正式站。

## E2E（隔离 HTTP + mock Feishu/DeepSeek）

证据目录：`/Users/xiangshu/Troublehut/_verify/asva-closed-loop-20261031/`

| 用例 | 结果 | 证据文件 |
| --- | --- | --- |
| A 新增→保存→worker→Source→Evidence→状态 | PASS | `A-create-closed-loop.json` |
| B pending=null Source=0 安全恢复 | PASS | `B-old-customer-recover.json` |
| C UPLOADED+pending清+实例死 → 真实结果 | PASS | `C-uploaded-resume.json` |
| D 重复/并发不重复证据 | PASS | `D-idempotent.json` |
| E DeepSeek 失败可恢复（mock） | PASS | `E-failure-recover.json` |
| F 真实环境未验证清单 | 列出 | `F-unverified-real-env.json` |
| G 目录/保存/课程回归 | PASS | `G-regression.json` |

相关回归：`automatic-processing-recovery-path` / `automatic-profile-processing` / `scoped-customer-ai-load` / `automatic-profile-pending-consistency` / `deploy-cloudbase` / `p0-core-http` / `http-customer-save` / `customer-save-p0` — 全绿。

## 真实环境尚未验证（F）

1. 真实飞书写入（Evidence/Customers 结构化字段）— 需发布授权
2. 真实 DeepSeek 成功路径 — 本轮仅 mock 失败路径
3. CloudBase SCF `Invoke(Event)` 到 `asva-ai-archive` — 需部署 + `TENCENTCLOUD_SECRETID/KEY`（或等价）与 Invoke 权限
4. Worker 生产耗时/超时/外网流量 — 未测
5. 生产客户数据 — **禁止本轮触碰**

飞书只读 search 兼容性：见既有能力/scoped-load 证据；本轮未再打生产。

## 受控发布（勿 merge dirty #54）

1. 检出本 tip SHA；`npm run build:cloudbase`（含 api + ai-archive）
2. `ASVA_DEPLOY_ENV_FILE=...` 配置：
   - 现有 asva-api 生产变量
   - `ASVA_AI_ARCHIVE_INVOKE_MODE=event`
   - `ASVA_AI_ARCHIVE_FUNCTION_NAME=asva-ai-archive`
   - `ASVA_AI_ARCHIVE_INVOKE_SECRET=...`（api 与 worker 一致）
   - `TENCENTCLOUD_SECRETID/SECRETKEY`（仅 api 侧 Invoke；最小 SCF Invoke 权限；**不暴露前端**）
3. 先部署 worker：`node scripts/deploy-cloudbase.mjs --worker-only`（或完整 deploy）
4. 再部署 asva-api；**按 tip SHA 受控部署，勿 merge dirty PR#54 到 master**
5. 勿开预置并发；memory 默认 512
6. Canary：用既有 `FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE=canary` + allowlist

## 回滚

1. 将 `ASVA_AI_ARCHIVE_INVOKE_MODE=disabled` 热配/重部署 asva-api → 停止新 Invoke
2. 回滚 asva-api 到上一 tip（如生产 `115b163` / 当前线上包）
3. worker 可保留或删除函数；pending/Source 状态仍可由 ADMIN 单客户 recover 兜底
4. 不回滚飞书表结构（本轮无 schema 大改）

## Git

- 后端 tip：`405016d0a9f2b14892f894373954a918708889d2`
- 分支：`fix/ai-archive-closed-loop-20261031`
- Draft PR：https://github.com/xiangshu3721/asva-workbench/pull/55 （draft，未 merge）
- 前端：无
