# AT008 二次 Source FAIL 诊断（ASVA-ARCHIVE-001）

## 定位结论（可多选）

- **(b) 重复 kickoff**：主链路 `extract→finalize` 已对 `SRC-d179313a2dda70c92736e93a` 达到 `COMPLETED` 后，验收脚本又调用了非 force 的 `FINALIZE2`（`runCustomerAutoArchive(..., { force:false, stage:'finalize' })`）。
- **(d) 其他（附证据）——contentHash 漂移**：`automaticProfileTextFromCustomer()` 会把 `notes` **加上** 已落盘的 `need` / `helpExpectation` / `goal`（见 `server/repository.mjs` ~858–864）。finalize 写入物理字段后，重入拼出的文本 hash 变为 `dabe7985…`，与主 Source hash `52503f0a…` 不同，于是 `queueAutomaticCustomerProfile` → `createSource` 新建了 `SRC-b6d4994db33bad45f52aa33f`（notes=`AUTO_PROFILE_ORGANIZE:HTTP_AUTO_ARCHIVE`）。
- **排除 (a)**：非 `saveFeedback` / `SERVICE_RECORD` 路径（二次 Source notes 为 `HTTP_AUTO_ARCHIVE`，非 `SERVICE_RECORD`）。
- **排除 (c) 遗留调度**：时间线紧跟 FINALIZE2 显式调用；非独立旧 timer。

## 关键对象

| 字段 | 值 |
|---|---|
| customerId | `CUS-db3032dea6f71877dc42`（合成） |
| main sourceId | `SRC-d179313a2dda70c92736e93a`（COMPLETED，hash `52503f0a…`，notes `CUSTOMER_SAVE`） |
| fail sourceId | `SRC-b6d4994db33bad45f52aa33f`（UPLOADED，hash `dabe7985…`，notes `HTTP_AUTO_ARCHIVE`） |
| trigger | FINALIZE2 / 非 force 重入 `runCustomerAutoArchive` |
| actor | `staff-admin-owner-001` |
| operation | `HTTP_AUTO_ARCHIVE_PROCESS` |
| result / error_code（初跑） | FAIL / `OPERATION_FAILED`（`run-rerun.log` @ 2026-10-31T12:33:23.082Z） |
| source.create requestId | `202610312033145B77997646CC24AE2FD8` |
| 本轮重入 errorCode | `ARCHIVE_FINALIZE_NO_EVIDENCE`（2026-10-31 21:18 Asia/Shanghai；无 Evidence 的孤儿 Source 上 finalize） |

## 影响证明

| 问题 | 结论 | 证据 |
|---|---|---|
| 额外 DeepSeek 账单（针对二次 Source 归档） | **否**（初跑 FAIL 前无 `[ASVA_DEEPSEEK]`；本轮重入 `modelCallsDuringResume=0`） | `run-rerun.log` 行序；`timeout-resume-test.json` |
| 初跑后另有 deepseek-chat | 有，但是 `REFRESH_CUSTOMER_UNDERSTANDING`（主路径完成后的理解刷新），不是二次 Source extract | `run-rerun.log` |
| 重复 Evidence / Proposal | **否**（保持 6 / 6；重入 delta=0） | `READBACK-rerun.json`；`timeout-resume-test.json` |
| 资料丢失 | **否**（主 Source COMPLETED；困扰/目标/期待与「AI整理·待核实」仍在） | `timeout-resume-test.json` before.physical/metaLabels |
| 多余失败/孤儿 Source | **是**（`SRC-b6d499…` 仍 UPLOADED） | Feishu 读回 sources 列表 |
| 阻断新增主业务落盘？ | **主路径未阻断**（CREATE→EXTRACT→FINALIZE 已成功）；但 **幂等重入/超时恢复被孤儿 Source 带偏** | isolation-summary-rerun + resume test |

## 源码对照

1. `saveFeedback`→`scheduleAutomaticCustomerProfile(...'SERVICE_RECORD')`（~4263）：本事故未走此路径。
2. `runCustomerAutoArchive` 在存在 auto-profile Source 时仍会 `queueAutomaticCustomerProfile`；queue 用 **当前** `automaticProfileTextFromCustomer` 的 hash 做 sourceOperationId，而非锁定主 COMPLETED Source。
3. `createSource` 对漂移后的新 hash 不会命中 `SOURCE_DUPLICATE`，故新建 `SRC-b6d499…`。
4. 对该空 Source 做 finalize → `ARCHIVE_FINALIZE_NO_EVIDENCE` → `HTTP_AUTO_ARCHIVE_PROCESS` FAIL。

## 对发布的含义

- 主路径隔离实测可完成物理字段归档。
- **超时恢复 / 重复 finalize（AT006/AT007）当前 FAIL**：会优先落到漂移 hash 的孤儿 Source。
- 建议修复方向（本任务 **不改代码**）：重入应优先复用同客户已有 COMPLETED/可恢复 auto-profile Source；`automaticProfileTextFromCustomer` 在已有 COMPLETED Source 时不应因物理字段回填改变 kickoff hash；或 finalize-only 禁止 createSource。
