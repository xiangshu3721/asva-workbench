# ASVA Stage 2 — 测评导入存储架构

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        ASVA 前端 (React)                         │
│  AssessmentPanel: 粘贴 → 预览 → 确认绑定 → 列表展示              │
└───────────────────────┬─────────────────────────────────────────┘
                        │ HTTP API
┌───────────────────────▼─────────────────────────────────────────┐
│                     ASVA 服务端 (Node.js)                         │
│                                                                   │
│  POST /api/assessments/import        → 预览（不绑定）             │
│  POST /api/customers/:id/assessments/confirm → 服务端重读+绑定    │
│  GET  /api/customers/:id/assessments → 客户测评列表              │
│  POST /api/assessments/bindings/:id/unbind   → 解绑（admin）     │
│  POST /api/assessments/bindings/:id/transfer → 转移（admin）     │
│  POST /api/assessments/bindings/:id/revoke   → 撤销（admin）     │
│  POST /api/assessments/bindings/:id/confirm-name → 姓名确认      │
│  POST /api/assessments/bindings/:id/consent  → 授权同意          │
│  GET  /api/assessments/bindings/:id/events   → 审计日志          │
└──────────┬────────────────────────────────────┬──────────────────┘
           │                                    │
     ┌─────▼─────┐                    ┌─────────▼────────┐
     │ assessment │                    │  PostgreSQL       │
     │ ReportDev  │                    │  (CloudBase)      │
     │ 公开端点   │                    │                    │
     │ (只读)     │                    │ asva_assessment_   │
     └───────────┘                    │   bindings         │
                                      │ asva_assessment_   │
                                      │   events           │
                                      └────────────────────┘
```

## 存储职责分工

### PostgreSQL (CloudBase 现有实例)

**权威存储：客户绑定关系 + 完整报告快照 + 审计日志**

- `asva_assessment_bindings`：绑定关系表
  - `UNIQUE (provider, report_id)` 保证全局唯一
  - 不可变 `snapshot` JSONB 列（完整报告）
  - `preview` JSONB 列（安全摘要）
  - 状态枚举：ACTIVE / UNBOUND / REVOKED / TRANSFERRED
  - 姓名不一致追踪 + 管理员确认记录
  - 客户同意追踪（customer_consent）
  - 源撤销 / 本地撤销分离追踪

- `asva_assessment_events`：审计事件表（append-only）
  - BOUND / UNBOUND / TRANSFERRED_OUT / TRANSFERRED_IN
  - REVOKED_SOURCE / REVOKED_LOCAL
  - NAME_CONFIRMED / CONSENT_GRANTED / CONSENT_REVOKED

- 所有写操作通过 `asva_assessment_guard()` RPC 函数，保证事务原子性
- 不修改原有 `asva_ai_budget_v1` 费用守门表
- 不新建数据库实例（复用 CloudBase 现有 PG）

### 飞书

- `tbljqgw8G2wzHLTU`（ASVA 测评索引）：**只读**，上游维护
- 不在飞书保存完整报告或 linkSecret
- 不在业务请求中自动创建飞书表

### assessmentReportDev

- 公开端点 `/v1/results/read`：**只读**
- 固定可信 URL，redirect: 'error'
- 15s timeout + 256KB streaming limit
- ASVA 不修改其配置

## 安全设计

### 报告真实性

- **confirm 接口不信任客户端**：仅接受 shareUrl
- 服务端解析 shareUrl → 提取 reportId + linkSecret
- 服务端重新从 assessmentReportDev 读取完整报告
- 验证 reportId 一致性（防伪造）
- 服务端生成 preview（不信任客户端 preview）

### 凭据保护

- `linkSecret` / `ownerToken` / 任何含 `secret` / `token` 字段 → **永不存储**
- shareUrl 存储时剥离 linkSecret 片段
- 日志中不记录凭据
- preview 响应不含 shareUrl

### 姓名一致性 (Issue #113)

- 报告署名 ≠ 客户姓名 → **默认阻止绑定**
- 管理员确认需记录：确认人 + 确认原因
- 仅管理员可确认（权限检查）
- 确认后记录到 `name_confirmed_by` / `name_confirmed_reason`

### 客户同意

- `customer_consent` 字段追踪 AI 使用授权
- 未获授权的报告**不进入 AI 上下文**
- 同意记录含时间戳和记录方式

### 撤销语义

- **源撤销**（source_revoked）：assessmentReportDev 撤销 linkSecret
  - ASVA 本地快照保留（审计用途）
  - 绑定状态变为不可读
- **本地撤销**（local_revoked）：ASVA 主动撤销访问
  - 快照保留，状态变为 REVOKED
  - 撤销后不可通过原客户访问
- 两种撤销独立追踪

### 跨客户信息泄露防护

- `REPORT_ALREADY_BOUND` 错误：
  - 管理员可见：现有客户姓名
  - 导师不可见：仅提示"已绑定到其他客户，联系管理员"

## 迁移方案

### 生产迁移步骤

1. 执行 SQL 迁移：
   ```
   cloudbase/migrations/20261124180000_asva_assessment_bindings.sql
   ```
2. 配置环境变量（复用现有）：
   - `ASSESSMENT_RPC_BASE_URL`（或复用 `ON_DEMAND_AI_BUDGET_RPC_BASE_URL`）
   - `ASSESSMENT_RPC_FUNCTION=asva_assessment_guard`
3. 部署 ASVA 服务端代码
4. 验证迁移

### 回滚方案

1. 回滚 ASVA 代码到 PR #124 之前版本
2. PG 表保留（不影响其他功能）
3. 如不需要，可 DROP 表

### 零停机

- 新表独立于现有业务
- RPC 函数独立，不影响 `asva_ai_budget_guard`
- 旧测评功能不受影响

## 成本

- **零新增付费资源**：复用 CloudBase 现有 PG 实例
- PG 表空间极小（测评报告数 KB 级）
- RPC 函数调用随正常业务流量

## 红线保护

- ✅ 零 DeepSeek 调用
- ✅ 无 auto-archive / cron / 轮询 / 扫描
- ✅ 无自动建表
- ✅ 无无限重试
- ✅ 未修改 R048.17 baseline
- ✅ 未修改 assessmentReportDev 配置
- ✅ 未修改费用守门机制
