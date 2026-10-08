# ASVA Stage 1 Baseline

记录时间：2026-10-07（Asia/Shanghai）

## Git / Release

- Branch：`stage-1-customer-foundation`
- Base commit：`7fc21190f76e59e5b6017877e58b12292473158a`
- Production release：`R001`
- 本阶段不执行 `npm run release:prepare`，不增加 Production Release Counter。

## Automated baseline

- `npm test`：111/111 PASS
- `npm run typecheck`：PASS
- `npm run build`：PASS
- `npm run schema:check`：PASS
- Schema：Missing/Extra/TypeMismatch 均为零；Customers 的 `导师ID` 为已登记 deprecated 字段。

## Current Feishu record counts

| Object | Table | Count |
|---|---|---:|
| Customer | Customers | 15 |
| Staff | Staff | 8 |
| Product | Products | 4 |
| Enrollment | Enrollments | 2 |
| ServiceRecord | ServiceRecords | 20 |
| ProfileChange | ProfileChanges | 13 |

补充：此前 Stage 0 `schema:check` 中的 `liveCount` 是字段数量，不是记录数量。本表使用 `FeishuRepository.load()` 的实际记录读取结果。

首轮 `customer:data-check` 发现 1 条既有 Customer 缺少手机号和微信号；该问题暂不静默迁移，列入 Stage 1 数据质量与迁移报告。

## Stage 1 scope lock

本阶段只建设 Customer Data Foundation V1：Customer Schema 分类、身份解析、统一联系方式校验、当前快照更新、字段来源、Profile Version、ProfileChanges、Enrollment Source of Truth、数据质量检查和现有 Customer UI 的最小整理。

本阶段不开发 ServiceCase、新预约流程、导师端登录、理论 Lens、临床风险、商业评分、客户合并、复杂 AI 或 Production 发布。
