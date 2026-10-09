# ASVA Stage 5｜服务安全与边界系统 V1

## 状态

- `STAGE3_STATUS = DEFERRED`
- `STAGE4_STATUS = COMPLETE`
- `BASELINE_RELEASE = R013`
- 本轮目标：`STAGE5_CODE_READY_FOR_PRODUCTION`
- 本轮不发布、不生成 R014、不修改 Production 数据。

Stage 5 V1 是服务安全边界系统，不是诊断系统、临床治疗系统，也不替代人工或持证专业判断。它回答的是：当前先确认什么、哪些服务动作需要暂停、是否需要人工介入。

## 六个最小能力

1. Safety Signal Extractor：从可靠资料中提取候选安全信号。
2. Clinical Risk Assessment：由服务端确定性规则计算 `UNKNOWN/R0-R4`。
3. Critical Safety Unknowns：记录影响服务边界的关键未知信息。
4. Service Gate：计算 `SAFETY_FIRST/STABILIZE_FIRST/ONE_TO_ONE/CONTINUITY/COURSE_READY`。
5. Service Boundaries：给出允许动作、避免动作、服务提醒和商业阻断。
6. Human Review Requirement：R2-R4、冲突、现实暴力/现实体验等进入人工复核。

Stage4 保持冻结。Stage5 不实现导师账号开放、Stage6 或 Stage8。

