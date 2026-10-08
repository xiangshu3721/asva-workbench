# ProfileUpdateProposal

逻辑实体 `ProfileUpdateProposal`，对应 Feishu 表 `ASVA 档案更新建议`。建议可暂存、回到列表继续审核、批量处理并审计。

动作：`ADD`、`UPDATE`、`APPEND`、`KEEP_CURRENT`、`REVIEW_REQUIRED`。变化：`NEW_INFORMATION`、`STATE_CHANGE`、`FACT_CONTRADICTION`、`CUMULATIVE_ADDITION`、`SUBJECTIVE_DIFFERENCE`、`NO_CHANGE`。

稳定事实（出生日期、性别、手机号、微信号）差异默认产生冲突，不能静默覆盖。城市、职业、工作状态、婚姻状态、关系状态、当前目标等可变事实按时间和来源形成更新建议，但仍需人工确认。累计字段使用 APPEND 并去重，主观字段保留多 Evidence。
