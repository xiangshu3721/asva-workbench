# ASVA Stage 5｜Integration Closure Report

## 最终状态

- `STAGE5_STATUS = INTEGRATION_VERIFIED`
- `STAGE5_CODE_READY_FOR_PRODUCTION = YES`
- `BASELINE_RELEASE = R013`
- `STAGE4_FROZEN = YES`
- `STAGE6 = NOT_STARTED`
- `PRODUCTION_CUSTOMER_DEEPSEEK_CALL = NO`
- `PRODUCTION_DATA_CHANGED = NO`
- `NEW_RELEASE_CREATED = NO`
- `DEPLOY_EXECUTED = NO`

本轮没有调用阿文、丽丽或小岚的 DeepSeek。受控集成只使用固定虚拟夹具，不写入 Feishu，不改变 Production 客户数据。

## 自动门禁

- `Tests = 187/187 PASS`
- `Typecheck = PASS`
- `Build = PASS`
- `Schema = PASS`
- `Customer Data = PASS`
- `Evidence Data = PASS`
- `Auth Data = PASS`
- `Orphan Check = PASS`
- `Secret Scan = PASS`

Schema 使用现有 Feishu tenant-token 链路完成只读检查。Stage 5 不需要新增 Production 表或字段，安全元数据复用客户记录 `_safety` 区域；可选 `safetyAssessments` 表未配置，因此跳过且不构成缺口。既有客户表的 `导师ID` 仍是已登记 deprecated 字段，不属于本轮差异。

## 受控 DeepSeek 集成

- `Controlled Fixtures = 7/7 PASS`
- 覆盖：`R2_PASSIVE_DEATH_WISH`、`R3_CURRENT_SELF_HARM`、`R4_IMMINENT`、`NEGATED`、`THIRD_PARTY`、`HISTORICAL`、`SPARSE_UNKNOWN`
- `R4 = SAFETY_FIRST + HARD_BLOCK`
- `R3 = SAFETY_FIRST + HARD_BLOCK`
- `R2 = STABILIZE_FIRST + HARD_BLOCK`
- `NEGATED / THIRD_PARTY / HISTORICAL` 未错误升级或归因
- `SPARSE_UNKNOWN = UNKNOWN`，没有降级为 R0 或课程就绪
- `Grounding = 0`
- `Negation Guard = 0`
- `Third-party Attribution Guard = 0`
- `Historical-as-current Guard = 0`
- `Hard-rule Miss = 0`
- `Conflict Auto-resolve = 0`
- `Unsupported Diagnosis = 0`
- `JSON Schema Final Valid = YES`
- `JSON Repair = 1 次以内；HISTORICAL 夹具使用 1 次修复后通过`

模型只输出候选信号、关键未知和上下文摘要；风险等级、服务 Gate、商业阻断和安全动作均由服务端确定性规则生成。

## 持久化与权限

- 支持并测试 `FRESH / STALE / PROCESSING / FAILED`
- 相同输入 fingerprint 幂等，不重复刷新
- 刷新失败保留既有安全 payload，并写入 `FAILED` 与安全错误码
- `GET /api/customers/:id/safety-assessment` 需要登录
- `POST /api/customers/:id/safety-assessment/refresh` 需要 ADMIN
- 不存在 R0 或课程就绪 fallback 绕过安全状态

## 后续边界

Stage 5 代码已完成本轮集成验证，但本轮不发布、不部署、不生成 R014。Production 客户的真实 DeepSeek 调用仍需后续明确授权和独立验收；Stage 4 保持冻结，Stage 6 未开始。
