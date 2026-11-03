# ASVA-ARCHIVE-001｜Codex 正式接管与上线交接（2026-10-31）

> **这是接力文档，不是生产已发布凭证。** 用户明确要求停止 Grok Bot 开发，改由 Codex 负责发布及后续研发；用户本轮明确授权正式上线。但目前 ChatGPT 未持有可用的腾讯云 CloudBase 登录/CLI 会话，故**只完成代码核查与 GitHub 交接存档，未执行后端或 Pages 发布**。

## 0. 读哪三处（按顺序）
1. [协议入口](../../README.md)、[任务规格](./task.yaml)（task ID `ASVA-ARCHIVE-001`，sha256 `7ac6dd4a02d3dde23301d2db3f5825c370cdf4c2d76deed603ef725d99f6741a`）。
2. [最新结构化交接状态](./handoff-20261031.json)；历史隔离执行回执见 [20261031 证据目录](./evidence/20261031/) 和 [INDEX](./INDEX.md)。
3. **真正要发布的业务代码**：[PR #56](https://github.com/xiangshu3721/asva-workbench/pull/56) @ 精确 SHA `8dd445020d9aa9f2be327458331b83f7411ca5e5`；不能拿协议分支 PR #57 当成业务构建代码。

## 1. 用户不变的产品目标
新增客户 → 完整原始资料快速写 Customers（保存返回不等待 AI）→ 独立 HTTP extract / finalize → DeepSeek → Feishu Source/Evidence/Proposal → 安全写 Customers 实体字段（AI整理·待核实、confirmed=false、保留出处）→ 导师前端刷新可见困扰/目标/帮助期待；重复操作不创建新 Source，不重复 DeepSeek。旧客户不自动批量归档，不覆盖人工确认字段。

## 2. 已核查源码及执行者回报：清楚区分
**ChatGPT 通过 GitHub 实际核查**：PR #56 tip 与上面 SHA 相同，仍 Draft / `mergeable=false`，相对 master 有 30 个文件变更；最后一次提交涉及 `server/index.mjs`、`server/repository.mjs`、`server/two-phase-http-auto-archive.test.mjs`、`src/App.tsx`、`src/clientApi.ts`。后端支持 FINALIZE 显式传递 `sourceId` 和复用原始任务身份，前端传入 sourceId，新增了归档完成后重入测试。**GitHub 未发现与该 SHA 对应的 CI workflow run。**

**Grok Bot 最后一次给用户的报告（尚未取得该 tip 的独立原始测试证据）**：AT001–AT010 全PASS，result_state=COMPLETE、ready_for_release=true，定向测试10/10；合成客户 `CUS-718ec371500b59b29cdb`、主 Source `SRC-d51785e454b4ae6b8d1513df`、真实飞书/DeepSeek + 浏览器Toast/档案待核实字段及刷新均成功；FINALIZE 幂等、没有新增 Source；浏览器测试用临时 `AUTH_MODE=ADMIN_CODE`，未加入代码。**这是执行方声明，不代表生产发布成功，且正式生产认证行为仍需真实冒烟。**

**上一批真实隔离原始证据**在协议PR #57的 `evidence/20261031`，历史版本为 `5764f8a` 并且 status=BLOCKED；不能把旧版证据改标签当作 `8dd4450` 新版验收成功。

## 3. 生产状态和真实发布路径
- 生产后端上次用户回执为 `115b163`；**需现场重新验证当前实际生效代码**（过去 `/api/health` 的环境变量 SHA 曾与运行代码不同，不可只看一处）。
- `master` SHA（本次核对）`efc96a6cd6daa0ec37f845a5a3729f4c5f872d0a`，`master` push 触发 `.github/workflows/deploy-pages.yml` 自动发布前端。
- **CloudBase 后端没有 GitHub 自动发布工作流**：在有腾讯云授权的本地环境执行经审核的 `npm run deploy:cloudbase` 所需的实际部署操作；配置保护由 `scripts/deploy-cloudbase.mjs` 提供。请先执行只读环境与CLI检查，不展示密钥。
- PR #56 仍 Draft、`mergeable=false`：**不允许强行合并全部30个文件/重置 master**，也不要先更新 master 造成“新前端 + 旧API”。应准备明确的最小可发布代码与 Pages 兼容变更，确认没有覆盖现有登录/目录/课程/UI。
- 发布顺序：**备份实际线上版本→核验精确release SHA与环境→后端先发布且接口/登录/目录健康→前端同套接口发布→仅必要的合成测试冒烟→核对飞书最终实体字段/显示→成功后记录线上SHA，失败回滚**。授权范围限这次新增客户功能发布，不包括星野、其他历史客户恢复、批量数据改写或无关功能改造。
- 需要的账号/云端部署权限来自用户已授权的 Codex 本地环境；**ChatGPT 此轮无法直接使用用户Mac的CLI，且现有浏览器连接并未登录腾讯云**。如果缺失权限，回执 `BLOCKED`，说明唯一阻断和具体用户操作，不要宣称已发布。

## 4. 发布后的 Codex 工作规范
- 你是新的唯一研发执行者；Grok Bot 从此退出这条任务的开发/发布。
- 先读本仓库 `AGENTS.md` 与 `.ai/README.md`（目前位于协议分支 PR #57，若 master 尚未合入需通过该分支链接显式加载）。
- 本任务沿用 `ASVA-ARCHIVE-001` 已确认意图；新功能先在 ChatGPT 对话确认，再 YAML 编译；无批准不得自行扩需求、改架构或批量写库。
- 提交新 `result.json` 必须真实绑定**实际部署的**代码 SHA、真实授权环境、真实测试读回/截图/阶段耗时及回滚状态；证据脱敏后保存 GitHub 有控制的路径。不能覆盖历史审查/执行回执。
- 五条不可绕过的检查：需求锁定、保护已成功基线、完整生命周期回归、真实证据、规格/代码/测试/生产版本一致性。

## 5. 完成/失败回执（唯一可向用户宣称「已经上线」的条件）
必须报告：production_backend_sha、production_frontend_sha、CloudBase env、Pages URL、部署时间、用户正常登录/客户目录、新建客户保存、EXTRACT/FINALIZE、Customers物理读回、浏览器Toast/档案/刷新、错误率、回滚包版本。**任何一项未知应标 NOT_VERIFIED，不得发布“全部成功”。**

**当前结论：代码已准备交接，生产发布未执行。**

> 任务状态以 [handoff-20261031.json](./handoff-20261031.json) 为准。
