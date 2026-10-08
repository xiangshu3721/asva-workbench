# Conflict Engine V1

逻辑实体 `EvidenceConflict`，对应 Feishu 表 `ASVA 信息冲突`。

冲突类型：`FACT_CONTRADICTION`、`POSSIBLE_STATE_CHANGE`、`SUBJECTIVE_DIFFERENCE`、`SOURCE_DISAGREEMENT`。状态：`OPEN`、`RESOLVED`、`DISMISSED`。管理员处理：`USE_NEW`、`KEEP_CURRENT`、`KEEP_BOTH`、`MARK_UNKNOWN`。

稳定事实冲突必须逐条选择；高敏感冲突和稳定事实冲突禁止批量确认。状态变化优先按发生时间理解，不把“2025 年南京、2026 年杭州”直接判成稳定事实矛盾。
