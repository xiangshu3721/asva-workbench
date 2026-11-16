# ASVA-ARCHIVE-001 — 脱敏证据索引（供 ChatGPT / 多平台只读）

时间（Asia/Shanghai）：2026-10-31  
分支：`docs/ai-intent-protocol-v1-20261031`（Draft PR#57，纯文档；与 PR#56 业务分支独立）  
候选 tip：`5764f8a2dc1a749e0b7c670ebd48e665697ab97a`  
`ready_for_release`：**false**  
`result_state`：**BLOCKED**（结构 validate PASS ≠ 业务放行）

## 声明

- **无密钥**：本目录及 `evidence/20261031/` 均为脱敏证据；不含 token、密码、环境密钥、真实客户原文。
- **无部署 / 无 merge / 无 force push**：仅文档与证据回执；未改业务源码。
- 合成客户 ID 可出现在脱敏轨迹中；勿当作生产放行依据。

## 回执文件怎么读

| 文件 | 说明 |
|---|---|
| `result.chatgpt-review.json` | ChatGPT 旧审核版（保留，勿覆盖） |
| `result.json` | 与上相同（任务根保留审核版，避免毁掉审核记录） |
| `result.executor-20261031.json` | 本次 Grok Bot Mac 隔离执行完整回执 |
| `evidence/20261031/result.json` | **同上 executor 最新回执（推荐 ChatGPT 从此处读）** |
| `evidence/20261031/RECEIPT.md` | 人读验收回执摘要 |
| `evidence/20261031/validate-stdout.txt` | 协议结构校验输出 |
| `evidence/20261031/evidence/*` | 全部脱敏证据文件 |
| `evidence/20261031/diagnose-second-source-and-resume.mjs` | 可选诊断脚本（无密钥） |
| `task.yaml` | 任务规格 |

## 如何跑 validate

在仓库根（本协议分支 checkout）或任意含 `.ai/` 的校验工作区：

```bash
# 依赖：pip install -r .ai/tools/requirements.txt
python3 .ai/tools/validate.py \
  --task .ai/tasks/ASVA-ARCHIVE-001/task.yaml \
  --result .ai/tasks/ASVA-ARCHIVE-001/evidence/20261031/result.json
```

期望：`协议结构与跨文件一致性：PASS（不等于真实业务验收通过）`  
参考本包已跑输出：`evidence/20261031/validate-stdout.txt`

## 证据目录树（20261031）

```
evidence/20261031/
  INDEX 指向本文件上级 INDEX.md
  RECEIPT.md
  result.json
  validate-stdout.txt
  diagnose-second-source-and-resume.mjs
  evidence/
    api-trace-desensitized.json
    browser-e2e.md
    diagnose-resume-stdout.txt
    feishu-readback-desensitized.json
    hashes.txt
    pr56-status.json
    prod-health-identity.json
    prod-health.headers.txt
    prod-health.json
    release-readiness.md
    second-source-fail-diagnosis.md
    tcb-fn-detail-asva-api.redacted.txt
    timeout-resume-test.json
    timing.json
```

## ChatGPT 推荐阅读顺序

1. 本 `INDEX.md`
2. `evidence/20261031/RECEIPT.md`
3. `evidence/20261031/result.json`
4. `evidence/20261031/evidence/second-source-fail-diagnosis.md`
5. `evidence/20261031/evidence/release-readiness.md`
