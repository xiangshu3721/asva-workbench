# Stage 5｜Risk 与 Service Gate 规则

LLM 只能输出候选信号和关键未知，不能输出最终风险等级、Gate 或商业阻断。最终结果只能由 `shared/safety-contract.mjs` 的确定性规则产生。

- `R4`：当前计划/意图同时出现，并有即时性或可用手段信息。
- `R3`：明确当前自伤、近期自伤、明确当前伤害他人、严重自我照料失败或现实检验重大担忧。
- `R2`：当前但含糊的自伤/死亡愿望、严重睡眠/功能问题、暴力控制、现实体验担忧、开放安全冲突。
- `R1`：有需要持续关注的低强度信号，但当前不满足 R2-R4。
- `R0`：资料充分且没有当前安全信号。
- `UNKNOWN`：安全数据不足，不能把“不知道”当成“没有风险”。

Gate 优先级：`R4/R3 → SAFETY_FIRST`，`R2 → STABILIZE_FIRST`，`R1 → CONTINUITY/ONE_TO_ONE/COURSE_READY`，`R0 → CONTINUITY/COURSE_READY`，`UNKNOWN → ONE_TO_ONE`。

R2-R4 为 `HARD_BLOCK`，ONE_TO_ONE 为 `SOFT_BLOCK`。R2-R4、冲突、现实暴力/现实体验和关键模型失败要求人工复核。

