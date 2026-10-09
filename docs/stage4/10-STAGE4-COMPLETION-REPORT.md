# Stage 4 Completion Report

`STAGE3_STATUS = DEFERRED`
`STAGE4_STATUS = COMPLETE`
`STAGE4_PRODUCTION_VERIFIED = YES`
`BASELINE_RELEASE = R013`
`STAGE5_STATUS = NOT_STARTED`

Stage 4 is the ASVA AI Customer Understanding V1 system. Its core principle is:

> 根据我们实际知道多少，决定此刻有资格理解到什么程度。

Production verification completed with `FE = R013`, `BE = R013`, `VERSION_MATCH = YES`, and `CloudBase Runtime = AVAILABLE`. The verified Production regression samples are 阿文、丽丽、小岚; no additional test labels are shown in the product UI.

Implemented in code: context builder, structured understanding contract, DeepSeek JSON generation with one repair attempt, grounding and safety checks, persisted status/fingerprint metadata, coalesced refresh scheduling, protected API endpoints, progressive Customer Detail UI with evidence traces, bounded Feishu read-after-write retries, and idempotent Source writes.

Final gates: `Tests = 171/171 PASS`, `Typecheck = PASS`, `Build = PASS`, `Schema = PASS`, `Customer Data = PASS`, `Evidence Data = PASS`, `Auth Data = PASS`, `Orphan Check = PASS`, `Manual Product Owner Smoke = PASS`.

## Stage 4 Generalization Matrix

| Context density | Standard sample | Goal | Result |
| --- | --- | --- | --- |
| RICH | 阿文 | 理解要深 | PASS |
| MEDIUM | 丽丽 | 理解要稳 | PASS |
| SPARSE | 小岚 | 理解要克制 | PASS；长期 Production 回归样本 |

Stage 4 不是固定生成十个模块。系统应根据当前资料密度，决定此刻有资格理解到什么程度：RICH 做更完整综合，MEDIUM 做有限综合并保留 Unknown，SPARSE 少结论、多关键未知、Discovery 优先。

三档策略：RICH 理解要深；MEDIUM 理解要稳；SPARSE 理解要克制。

### Fixed Regression Matrix

| Sample | Context Density | Verified scenario | Result |
| --- | --- | --- | --- |
| 阿文 | RICH | 资料丰富、复杂综合理解 | PASS |
| 丽丽 | MEDIUM | 中等资料、有限综合 + Unknown | PASS |
| 小岚 | SPARSE | 低资料、少结论 + Knowledge Gaps + Discovery | PASS |

## R013 Reliability Scope

- Feishu customer read-after-write 使用统一 bounded retry helper；仅在最近一次 Customer 创建写入窗口内允许回读重试，普通不存在 Customer 快速返回 404。
- Source 创建继续使用 `operation_id` / `content_hash` 幂等约束，回读未确认前不假装 Source 已成功。
- Understanding Context Density 集中定义 RICH / MEDIUM / SPARSE 阈值。
- Sparse 输出不强制议题、Core Blocks、Resources 或 Tensions；Knowledge Gaps 优先，Next Conversation 保持 Discovery-oriented，Overall Confidence 允许 LOW。

## Frozen Stage 4 Definition

Stage 4 已冻结以下能力：

- CustomerUnderstandingV1 与 10 Module Schema
- Understanding Context Builder 与 Context Density Policy（RICH / MEDIUM / SPARSE）
- Evidence Grounding、Knowledge Gaps、Working Hypothesis、Next Conversation、Service Cautions
- Privacy Minimization、Diagnosis Guard、Conflict Handling、Current / Historical Separation
- FRESH / STALE / PROCESSING / FAILED 状态机
- Fingerprint Idempotency 与 Feishu read-after-write reliability
- Stage 4 Customer Detail UI

除 Production Bug 或明确产品迭代外，不随意修改 Stage 4。

## Stage 4 Closure Status

`CODE_CHANGED = NO`
`PRODUCTION_DATA_CHANGED = NO`
`NEW_RELEASE_CREATED = NO`
`DEPLOY_EXECUTED = NO`

Backlog（仅记录，未实现）：基础设施 Health / 余额异常提醒、Stage 3 未来服务记忆系统、Stage 5 后续能力、更长期真实客户样本回归。
