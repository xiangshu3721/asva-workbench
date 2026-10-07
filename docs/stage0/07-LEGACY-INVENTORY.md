# Legacy Inventory

| 遗留 | 当前处理 | 本阶段不做 |
|---|---|---|
| `X-Staff-Id` | demo 兼容；production 忽略 | 不继续作为生产认证 |
| Customers `导师ID` | 只读兼容、标记 deprecated | 不删除现场字段 |
| appointments / ServiceCase 两套语义 | 文档冻结为 Appointment 与 ServiceCase 映射关系 | 不新建表、不迁移状态 |
| external appointment POST | `FEATURE_EXTERNAL_APPOINTMENT=false` 时返回 403 | 不删除旧代码/数据 |
| SABC | 保留现有字段和逻辑 | 不重构评分算法 |
| FeishuRepository | 继续作为主 repository，增加契约/边界 | 不做全量重写 |

以下内容均不属于 Stage 0：12 层 Life OS、临床风险、BI、今日关怀 AI、Lens、多主体、八字、CRM/营销和预约新业务。
