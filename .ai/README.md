# 翔叔 AI 研发意图编译与验收协议 · V1.0

**这里是本项目 AI 研发交接的固定入口。** 自然语言仍用于与用户澄清需求；机器执行以**已确认的结构化任务契约和实际仓库代码**为准；完成与否以**逐项真实证据**为准。

## 30 秒接手流程

1. 阅读 [`AGENTS.md`](../AGENTS.md) → [协议正文](protocol/PROTOCOL.md) → [项目上下文](project/context.yaml)。
2. 找到被指派任务的 `task.yaml`；核对 `protocol`、`task_id`、`spec_version`、`approval`、`project.base_sha` 与当前仓库。
3. 先运行验证器；若 `APPROVED`、边界和环境条件不满足，返回 `BLOCKED`，**不得猜测并动手**。
4. 对每项 `requirements` 找到相应 `acceptance`。不得把某一项“单测通过”视作整个功能完成。
5. 实施时按明确的允许范围操作；不碰生产、不重写无关模块。结果写 `result.json`，附证据，运行验证器。
6. 返回精简的人话摘要与 GitHub SHA/PR/证据路径；交 ChatGPT/用户终审。

## 文件导航

| 路径 | 功能 |
| --- | --- |
| `protocol/PROTOCOL.md` | 角色、状态机、编译规则、验收门禁、协作规则 |
| `protocol/CHANGELOG.md` | 版本历史和迭代规则 |
| `schemas/task.schema.json` | YAML 任务契约的 JSON Schema（解析后校验） |
| `schemas/result.schema.json` | JSON 标准回执的 JSON Schema |
| `templates/task.yaml` | 新需求任务模板 |
| `templates/result.json` | 研发执行回执模板 |
| `project/context.yaml` | 本项目稳定资料及必须重新核对的易变信息 |
| `tools/validate.py` | 解析 YAML、校验 Schema、检查任务与回执的一致性 |
| `tools/requirements.txt` | 验证器依赖 |

## 运行校验

```bash
python3 -m pip install -r .ai/tools/requirements.txt
python3 .ai/tools/validate.py task .ai/templates/task.yaml
python3 .ai/tools/validate.py result .ai/templates/task.yaml .ai/templates/result.json
python3 .ai/tools/selftest.py
```

模板中的示例状态为 `DRAFT` / `PARTIAL`，**验证格式通过不代表任务获批准、业务验收通过或允许部署**。

## 实际任务与交付约定

- 新任务放在 `.ai/tasks/<TASK_ID>/task.yaml`；执行结果放 `.ai/tasks/<TASK_ID>/result.json`。
- `task_id` 稳定唯一；需求修改须提升 `spec_version`（不覆盖旧批准历史）。结果绑定任务文件的 `spec_sha256`。
- 大型证据放项目内允许的文档路径、CI产物或受控外部文件链接；本仓库**不提交凭证、生产原始客户资料或敏感日志**。私人本机绝对路径不算可供换平台直接读取的充分证据。
- 对历史任务，GitHub PR/Commit/文档优先于聊天摘要；每次接手仍以实际线上环境和当前分支核对为准。
- 本协议可复制到其他仓库；每个项目各自维护 `project/context.yaml`，不要把 ASVA 的具体事实强加给别的项目。

**初始发布方式**：先建文档分支与独立 PR。此仓库的 `master` 推送会自动发布 Pages；在确认安全前不为了加入文档强推 `master`。