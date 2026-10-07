# Customer Schema Change Rules

从 Stage 1 开始，Customer 主表字段不是 Prompt 临时想到就能新增的自由空间。

新增字段必须同时满足：

1. 现有字段无法表达；
2. 属于 Customer 的长期当前快照，而不是一次服务、预约、历史事件、Enrollment 关系或 AI 结果；
3. 不是人格、依恋、家庭系统、发展阶段、临床风险等理论 Lens 结论；
4. 有明确的中文语义、数据类型、字段族、编辑权限、来源与 AI 写入边界；
5. 能说明是否为核心字段、是否 Derived、是否历史/Deprecated，以及未来迁移方式；
6. 同步更新 `server/field-mapping.mjs`、Schema Contract、Domain 类型、前端使用说明、数据质量检查与测试；
7. 经过产品确认后，才允许变更真实 Feishu Customers 表。

以下内容不得直接新增为 Customer 字段：ServiceCase 状态、Appointment 状态、ServiceRecord 事件明细、Enrollment 关系、AI 推断、心理诊断、理论模型结果。它们应分别留在对应实体或未来 Insight / Assessment 体系。

任何真实表变更前必须先生成快照，迁移脚本必须幂等，明确输出修改前后数量、具体修改项和冲突项；发现身份冲突时停止自动写入。`导师ID` 等 Deprecated 字段只允许兼容读取，不得成为新写入口。
