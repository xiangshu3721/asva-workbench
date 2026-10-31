# AI 研发协作入口（适用于本仓库）

> **开始任何研发任务前先读** [`.ai/README.md`](.ai/README.md)，然后读 [`.ai/protocol/PROTOCOL.md`](.ai/protocol/PROTOCOL.md) 和对应任务契约。本文件仅提供发现入口，不能替代实际代码核查。

## 所有 AI 执行者的统一纪律

1. **先读后做**：读取本仓库实际代码与对应任务；区分用户已确认需求、代码证据和 AI 推断。不能依赖聊天记录里的过期 SHA、环境信息或部署状态。
2. **按契约执行**：任务未达到 `APPROVED` 且缺少用户确认来源时，先返回 `BLOCKED`，不得自行扩大范围；需求冲突则发起变更请求。
3. **不以“代码改完”代替“业务通过”**：每个必选验收项要附真实、可访问、可复核的证据。Mock PASS 不能冒充真实飞书/DeepSeek或生产成功。
4. **默认不写生产**：未经任务明确授权，不部署、不开生产开关、不写真实客户、不改生产配置、不合并其他业务 PR；不得打印密钥或私人资料。
5. **统一回执**：交付 `result.json`，按 `.ai/schemas/result.schema.json` 校验；任何 FAIL / BLOCKED / NOT_TESTED 的必选项，都不得宣称已完成或可发布。
6. **不要自行改协议**：有改进建议写入回执 `improvement_proposals`，经人类审阅后以单独协议版本更新。

**快捷入口**：`.ai/README.md` → `.ai/project/context.yaml` → `.ai/templates/task.yaml` → `.ai/tools/validate.py`。

**作用域**：协议约束研发协作，不改变业务运行逻辑；如果本仓库其他规则或平台权限更严格，遵守更严格者。