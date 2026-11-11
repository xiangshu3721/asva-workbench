# ASVA-ARCHIVE-001 验收回执（证据补齐）

时间（Asia/Shanghai）：2026-10-31 约 21:16–21:25  
Executor：Grok Bot (Mac isolation evidence)  
候选 tip：`5764f8a2dc1a749e0b7c670ebd48e665697ab97a`（已 `git rev-parse HEAD` 核对；未改业务代码、未 merge、未部署）  
合成客户：`CUS-db3032dea6f71877dc42`  
协议 `spec_sha256`：`7ac6dd4a02d3dde23301d2db3f5825c370cdf4c2d76deed603ef725d99f6741a`  
`result_state`：**BLOCKED** · `ready_for_release`：**false**  
验证器：结构 PASS（≠ 业务 PASS）— 见 `validate-stdout.txt`

---

## 【完成】

1. 按协议从既有隔离闭环提炼脱敏证据包到  
   `/Users/xiangshu/Troublehut/_verify/asva-archive-001-20261031/`
2. 定位二次 Source FAIL：`SRC-b6d4994db33bad45f52aa33f`  
   - 原因 **(b) 重复 kickoff（FINALIZE2）** + **(d) contentHash 漂移**（finalize 后 `automaticProfileTextFromCustomer` 拼入已落盘字段）  
   - 排除 (a) SERVICE_RECORD；(c) 遗留调度  
   - **无**针对该孤儿 Source 的额外 DeepSeek 归档调用；Evidence/Proposal **未**暴增；主路径物理字段 **未**丢  
   - 残留：孤儿 Source 仍 `UPLOADED`
3. 非 force finalize 重入实测：`FAILED` / `ARCHIVE_FINALIZE_NO_EVIDENCE`（命中孤儿 Source）
4. 只读确认生产 asva-api = **115b163 / R048.11**；PR#56 Draft + dirty；未部署
5. 输出 `result.json` 并跑通 `validate.py`（结构 PASS）

## 【查看】

| 文件 | 说明 |
|---|---|
| `result.json` | AT001–AT010 正式回执 |
| `evidence/api-trace-desensitized.json` | SAVE/EXTRACT/FINALIZE 脱敏轨迹 |
| `evidence/feishu-readback-desensitized.json` | 飞书读回脱敏 |
| `evidence/timing.json` | 墙钟 |
| `evidence/timeout-resume-test.json` | 幂等/超时恢复重入 |
| `evidence/second-source-fail-diagnosis.md` | AT008 诊断 |
| `evidence/browser-e2e.md` | AT005 未测说明 |
| `evidence/release-readiness.md` | AT009 闸门 |
| `evidence/hashes.txt` | sha256 |
| `validate-stdout.txt` | 验证器输出 |
| 既有主链路 | `/Users/xiangshu/Troublehut/_verify/asva-pr56-final-closed-loop-20261031/` |

## 【测试】

| AT | 状态 | 要点 |
|---|---|---|
| AT001 | PASS | 合成客户原文/物理读回 |
| AT002 | NOT_TESTED | SAVE 4450ms 有 api_trace，缺 browser toast |
| AT003 | PASS | 真实 DeepSeek extract + Evidence |
| AT004 | PASS | Proposal + 待核实 meta |
| AT005 | NOT_TESTED | 无法登录隔离前端；无截图 |
| AT006 | FAIL | 分阶段耗时 OK，超时恢复 FAIL |
| AT007 | FAIL | 重复 finalize 命中孤儿 Source |
| AT008 | PASS | 二次 FAIL 已定位并证明主路径资料未丢 |
| AT009 | PASS | 只读闸门文档；未部署 |
| AT010 | PASS | commit/PR 结构审阅 |

## 【问题】

1. **幂等/恢复阻断**：finalize 后 contentHash 漂移 → 新建 `SRC-b6d499…` → 重入 `ARCHIVE_FINALIZE_NO_EVIDENCE`
2. **浏览器未测**：缺 ADMIN 登录交互；生产 Pages≠候选 tip
3. **PR#56** Draft 且 `mergeable_state=dirty`；生产仍 115b163
4. 审计噪音：EXTRACT_READY 仍带 `error_code=OPERATION_FAILED`

## 【Git】

- 分支：`fix/two-phase-new-customer-archive-20261031`
- HEAD：`5764f8a2dc1a749e0b7c670ebd48e665697ab97a`（冻结）
- 本任务仅写入 `_verify/asva-archive-001-20261031/` 证据目录；**未**推 tip、未 merge、未 deploy
- PR：https://github.com/xiangshu3721/asva-workbench/pull/56

## 【下一步】

1. 修重入：finalize-only / 恢复必须锁定已有 COMPLETED auto-profile Source，禁止因字段回填改 hash 建新 Source  
2. 清理或隔离孤儿 `SRC-b6d499…`（合成客户，勿动真实客户）  
3. 补 AT005：本地 tip 5764f8a + vite，登录后截图困扰/目标/帮助期待 +「AI整理·待核实」并刷新复核  
4. 补 AT002 browser toast 时间线  
5. 人审 Canary（仅合成客户）前保持 **ready_for_release=false**；回滚基线 **115b163**
