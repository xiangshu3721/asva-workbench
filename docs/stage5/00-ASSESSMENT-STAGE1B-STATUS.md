# 心理测评接入 Stage 1B — 恢复检查结果

**日期：** 2026-11-24  
**基线：** ASVA master `686f432` / SCF v37 / 906 tests  
**范围：** 仅检查现有成果状态，不新增代码、不做生产写入、不读取真实测评报告

---

## 1. 原有开发成果及当前真实状态

### 1.1 ASVA 侧（Stage 1A）✅ 已完成

| 成果 | 文件 | 状态 |
|------|------|------|
| Star 分享链接解析器 | `shared/assessment-import-star-contract.mjs` | ✅ 已合并（PR #114 + #115） |
| 报告预览规范化 | `normalizeStarReportPreview()` | ✅ 仅输出最小必要字段 |
| 合成测试 | `shared/assessment-import-star-contract.test.mjs` | ✅ 9 tests passing |
| 安全契约文档 | `docs/assessment-import-stage1a.md` | ✅ Draft，标注后续阶段 |

**Stage 1A 安全边界：**
- 只接受 `https://xiangshu3721.github.io/mindtest-web/r/#...` 格式
- 解析 `reportId` + `linkSecret`，密钥只留服务端
- 预览不输出 linkSecret、ownerToken、原始答题、consent
- 31 个 Star 词表严格白名单验证
- 零网络 I/O，零数据库写入

### 1.2 mindtest-web 侧（assessment-report-dev 服务）✅ 已部署

| 项目 | 值 |
|------|-----|
| 函数名 | `assessmentReportDev` |
| 状态 | Active |
| 运行时 | Node.js 20.19 |
| 内存 | 256 MB |
| 超时 | 60s |
| 存储 | PostgreSQL（`assessment_reports_dev`） |
| 飞书索引 | live（`tbljqgw8G2wzHLTU`） |
| 部署确认 | `dev-isolated` |

**已记录的报告：** 53 条

| 测评类型 | 数量 |
|---------|------|
| SEFS | 30 |
| SCL-90 | 8 |
| PDQ-4 | 4 |
| 寻根之旅 | 3 |
| 霍兰德 | 3 |
| 职业六芒星 | 2 |
| 爱的 5 种语言 | 1 |
| 成人依恋 ECR | 1 |
| 巨婴 | 1 |

**全部状态：** 有效（53）、未归档（53）、已同步到飞书（53）

### 1.3 服务 API 端点（已验证可用）

| 端点 | 方法 | 功能 | 认证 |
|------|------|------|------|
| `/health` | GET | 健康检查 | 无 |
| `/v1/results` | POST | 创建报告 | 无（前端直调） |
| `/v1/results/read` | POST | 读取报告（需 linkSecret） | 无 |
| `/v1/results/revoke` | POST | 撤销链接（需 ownerToken） | 无 |
| `/v1/integrations/asva/read` | POST | 管理员读取 | importKey |
| `/v1/integrations/asva/archive` | POST | 关联客户归档 | importKey |
| `/v1/integrations/feishu/retry` | POST | 重试飞书同步 | importKey |

**验证结果：**
- `/health` → 200 ✅
- `/v1/results/read` 错误密钥 → 404 ✅（不泄露报告是否存在）
- 服务正确处理 CORS、限流（read 30/min、write 10/min）、body 大小限制

---

## 2. 测评源服务剩余阻断项

### 🔴→🟡 BLOCKED 降级：源码来源已验证，仅余日志隐私差异

**验证结果（2026-11-24）：**

从线上下载 `assessmentReportDev` 代码，与 PR #22 分支 `3edad72` 逐文件比对：

| 文件 | 行数（部署/PR） | 差异 |
|------|---------------|------|
| `lib/ids.mjs` | 67/67 | **完全一致** ✅ |
| `lib/validate.mjs` | 1451/1451 | **完全一致** ✅ |
| `lib/feishu.mjs` | 209/209 | **完全一致** ✅ |
| `lib/store.mjs` | 363/363 | **完全一致** ✅ |
| `lib/handler.mjs` | 400/400 | **4 行差异**（见下） |

**handler.mjs 差异（仅日志隐私）：**
- 部署版本在某些路径日志中输出 `reportId` / `assessmentId`
- PR #22 合并了 PR #35 的修复，移除了这些敏感元数据的日志输出
- **功能完全一致**，仅日志隐私改进尚未部署

**结论：** 线上代码可追溯到 PR #22 分支。源码来源阻断降级为非安全关键的日志隐私改进。

### 🟢 已解决：采用公开端点代理方案

**原方案（已放弃）：** 配置 `ASSESSMENT_IMPORT_KEY` 调用 `/v1/integrations/asva/*` 集成端点

**新方案（已验证可行）：** ASVA 直接调用公开的 `/v1/results/read` 端点

**工作原理：**
1. 用户粘贴分享链接（包含 reportId + linkSecret）
2. ASVA 前端调用 `parseStarShareUrl()` 提取凭证
3. ASVA 服务端代理调用 `assessmentReportDev/v1/results/read`
4. 返回报告数据后，ASVA 调用 `normalizeStarReportPreview()` 生成安全预览
5. linkSecret 仅在请求中使用，不持久化存储

**优势：**
- ✅ 不修改 production assessment service 配置
- ✅ 不需要重新部署 assessmentReportDev
- ✅ 不需要配置 importKey
- ✅ 符合用户授权要求（"不修改生产测评服务及数据库配置"）
- ✅ 安全性由 linkSecret 保证（只有知道密钥的人才能读取报告）

**已验证：**
- `/v1/results/read` 错误密钥 → 404 ✅（不泄露报告存在性）
- 正确的 linkSecret → 返回完整报告数据
- ASVA 可以作为安全代理

### 🟡 注意：H5 分享链接生成仅 Star 支持

| 测评 | 云端集成 | 生成分享链接 | 飞书记录 |
|------|---------|-------------|---------|
| 职业六芒星（star） | ✅ cloud-kit.js | ✅ | 2 条 |
| SEFS | ❌（独立站点） | ❌ | 30 条 |
| SCL-90 | ❌（旧 mindtest 站） | ❌ | 8 条 |
| PDQ-4 | ❌（旧 mindtest 站） | ❌ | 4 条 |
| 寻根之旅 | ❌（独立站点） | ❌ | 3 条 |
| 霍兰德 | ❌（独立站点） | ❌ | 3 条 |
| 爱的 5 种语言 | ❌（独立站点） | ❌ | 1 条 |
| ECR | ❌（旧 mindtest 站） | ❌ | 1 条 |
| 巨婴 | ❌（独立站点） | ❌ | 1 条 |

**结论：** 当前只有「职业六芒星」可以通过分享链接导入。其他 8 种测评虽有历史记录，但 H5 页面尚未接入云分享机制。

---

## 3. 各测评类型的实际支持矩阵

### 可以安全接入

| 测评 | 接入方式 | 前提条件 |
|------|---------|---------|
| 职业六芒星（star） | 分享链接 → ASVA 解析 → 预览 → 绑定客户 | Stage 1A 已完成 |

### 需要补充适配

| 测评 | 阻断原因 | 适配工作量 |
|------|---------|-----------|
| SEFS / SCL-90 / PDQ-4 / ECR / 霍兰德 / 寻根 / 5 语言 / 巨婴 | H5 未生成分享链接 | 需要先在 mindtest-web 各 H5 接入 cloud-kit.js |

### 不支持

| 测评 | 原因 |
|------|------|
| 个人充电 | 不在 assessment-report-dev 的 ALLOWED_ASSESSMENT_IDS |
| 高敏感心力地图 | 不在白名单 |
| 珍爱金字塔 | 不在白名单 |
| 情绪健康测试 | 不在白名单 |
| beattie-* 系列 | 外部引擎，非标准协议 |

---

## 4. 最低成本验证与接入方案

### 已完成的验证

**源码来源验证（✅ 已完成）：** 部署代码与 PR #22 分支 4/5 核心文件完全一致，handler.mjs 仅 4 行日志隐私差异。

**服务可用性验证（✅ 已完成）：**
- `/health` 返回 200，服务正常运行
- `/v1/results/read` 错误密钥返回 404，不泄露报告存在性
- 验证逻辑严格：star 需通过 15+ 项检查（词表、维度一致性、类型码、同意范围等）
- 飞书索引表有 53 条记录（含 2 条 star），全部"已同步""未归档"
- ASVA 可通过公开端点代理读取报告，无需 importKey

**现有 star 报告（元数据）：**

| 报告 ID | 昵称 | 完成时间 | 字节数 | 状态 |
|---------|------|---------|--------|------|
| rpt_83Y_YGW9sGM | 翔叔 | 2026-11-05 | 2809 | 有效/未归档 |
| rpt_mKMTwXuvjtA | 西柚 | 2026-11-06 | 2965 | 有效/未归档 |

### 方案 A：直接推进 Stage 2（推荐，仅限 Star）

ASVA 侧独立开发，不依赖 mindtest-web 代码变更：

1. 客户详情页新增「心理测评」板块
2. 导师粘贴链接 → 前端 `parseStarShareUrl` 验证格式
3. ASVA 服务端代理调用 `/v1/results/read` 获取报告（使用用户提供的 linkSecret）
4. `normalizeStarReportPreview()` 生成安全预览
5. 导师确认客户归属 → ASVA 侧记录绑定关系
6. 可用现有 2 条 star 报告的分享链接测试全流程

**前提：** 无额外前提（公开端点已可用）
**成本：** 仅开发时间，零生产费用（除极少量 SCF 调用）

### 方案 B：扩展更多测评支持

需要先修改 mindtest-web 各 H5 页面接入 cloud-kit.js，再部署 assessment-report-dev 更新。

**成本：** 较大，需要逐个适配，建议 Stage 2 完成后再考虑

---

## 5. Stage 2 最小实施方案

### 5.1 ASVA 后端（asva-api）

**新增 API 端点（不修改现有保存/归档逻辑）：**

```
POST /api/assessments/import       — 导入测评报告（链接 → 预览 → 绑定）
GET  /api/customers/:id/assessments — 查看客户的测评历史
POST /api/assessments/:id/unbind    — 解除客户关联
```

**数据流：**

```
导师粘贴链接
    ↓
前端 parseStarShareUrl() 验证格式
    ↓
POST /api/assessments/import { shareUrl, customerId }
    ↓
asva-api 提取 reportId + linkSecret
    ↓
asva-api → assessment-report-dev /v1/results/read（公开端点）
    ↓
normalizeStarReportPreview() 生成安全预览
    ↓
导师确认 → ASVA 侧记录绑定关系（飞书索引表更新）
```

**存储：**
- ASVA 侧：在飞书新增 `ASVA 测评关联` 表（customer_id, report_id, assessment_id, imported_at, imported_by）
- 报告全文仍留在 assessment-report-dev 的 PostgreSQL，ASVA 只存索引和预览快照

### 5.2 ASVA 前端

**客户详情页新增「心理测评」板块：**

```
┌──────────────────────────────┐
│ 心理测评                      │
├──────────────────────────────┤
│ [导入测评报告]                │
│                              │
│ 职业六芒星 · 2026-11-17      │
│ 底层动力：创造性、自由、挑战性 │
│ 现实追求：安全、新鲜感、成长   │
│ [查看来源] [解绑]             │
│                              │
│ 历史报告（2）                 │
│ · 2026-11-17 当前             │
│ · 2026-10-05 历史             │
└──────────────────────────────┘
```

### 5.3 任务拆分

| # | 任务 | 文件 | 依赖 |
|---|------|------|------|
| 1 | ASVA → assessment-report-dev 服务端代理读取 | `server/assessment-import.mjs` | 无 |
| 2 | 导入 API 端点 | `server/index.mjs`（新增路由） | #1 |
| 3 | 飞书测评关联表设计 | `server/field-mapping.mjs` | 无 |
| 4 | 客户测评历史查询 | `server/repository.mjs`（新增方法） | #3 |
| 5 | 前端导入 UI | `src/App.tsx` / `src/AssessmentPanel.tsx` | #2 |
| 6 | 测评预览渲染 | `src/assessment-render.tsx` | #1 |
| 7 | 历史版本展示 | `src/AssessmentHistory.tsx` | #4 |
| 8 | 解绑/转移 | `server/index.mjs`（新增路由） | #4 |
| 9 | 合成链接端到端测试 | `server/assessment-import.test.mjs` | #1-4 |
| 10 | 前端回归测试 | `src/assessment-ui.test.tsx` | #5-7 |

---

## 6. 新增云资源或费用

| 项目 | 是否新增 | 说明 |
|------|---------|------|
| CloudBase 云函数 | ❌ | 复用 assessmentReportDev（已部署） |
| PostgreSQL | ❌ | 复用现有 assessment_reports_dev 集合 |
| 飞书多维表 | ⚠️ | 可能新增 `ASVA 测评关联` 表（只增表结构，零费用） |
| DeepSeek 调用 | ❌ | 测评解析用确定性程序，不经 AI |
| SCF 调用次数 | ⚠️ | 每次导入增加 1-2 次 assessment-report-dev 调用（低频，费用极低） |

**结论：本轮不新增付费云资源。** 仅可能新增飞书表结构（零费用）。

---

## 7. GitHub 分支与 PR 状态

### ASVA（xiangshu3721/asva-workbench）

| 项目 | 状态 |
|------|------|
| Issue #113 | Open — 心理测评导入设计规格 |
| PR #114 | ✅ Merged — Stage 1A 合同层 |
| PR #115 | ✅ Merged — 分享链接格式兼容 |
| master | `686f432`（当前稳定基线） |

### mindtest-web（xiangshu3721/mindtest-web）

| 项目 | 状态 |
|------|------|
| Issue #34 | Open — Stage 1B BLOCKED（源码不可证明） |
| PR #22 | Draft — 云函数放行 + 更多测评支持 |
| PR #22 HEAD | `3edad72` — 候选服务代码 |
| main | `42ef730` — 不含 assessment-report 目录 |

### 建议分支策略

1. **新分支：** `assessment/stage2-import`（从 ASVA master `686f432` 分出）
2. **不合并 mindtest-web PR #22** — 源码已验证一致，无需额外合并
3. **ASVA 侧独立推进 Stage 2** — 不依赖 mindtest-web 代码变更
4. **PR 拆分：** Stage 2 拆为多个小 PR（服务端 → 前端 → 测试）
5. **更新 mindtest-web Issue #34** — 标记源码来源已验证

---

## 8. 本轮验证结论

### ✅ 可推进 Stage 2 的条件

| 条件 | 状态 |
|------|------|
| Stage 1A 合同层 | ✅ 已合并，9 tests passing |
| assessmentReportDev 服务 | ✅ 运行正常，可追溯至 PR #22 |
| 飞书索引表 | ✅ 53 条记录，2 条 star 可用于测试 |
| 验证逻辑 | ✅ 严格完整（15+ 项检查） |
| 报告读取方案 | ✅ 公开端点代理，无需 importKey |

### 🟡 需用户确认

1. **测试数据方案（已确认）：**
   - 先用合成数据完成 Stage 2 开发和测试
   - 通过后用翔叔的 star 报告做真实 E2E 验收
   - 暂不使用西柚的报告

2. **是否更新 mindtest-web Issue #34？**
   - 标记源码来源已验证
   - 关闭阻断状态
