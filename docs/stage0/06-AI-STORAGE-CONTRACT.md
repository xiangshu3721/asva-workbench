# AI Storage Contract

本阶段不重构现有 AI 算法。所有 AI 输出必须可识别来源：`RULE` 或 `DEEPSEEK`，并保留生成时间、应用版本、关联 customer/service record、输入摘要和状态。

## Brief

```text
customer_id
source: RULE | DEEPSEEK
generated_at: ISO-8601
app_version
release
confirmed: string[]
to_confirm: string[]
entry_points: string[]
suggested_questions: string[]
status: READY | UNAVAILABLE | STALE
```

AI 失败不覆盖既有人工事实，不伪造成功；前端显示“AI 仅供参考”。
