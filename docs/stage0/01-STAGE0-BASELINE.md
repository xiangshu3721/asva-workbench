# ASVA Stage 0 基线

> 记录时间：2026-10-07（Asia/Shanghai）
>
> 本文件只记录 Stage 0 开始前的可验证基线，不把“代码存在”写成“生产已验收”。

## Git 与分支

| 项目 | 基线 |
|---|---|
| 工作仓库 | `/Users/xiangshu/Troublehut/asva-workbench` |
| Stage 0 分支 | `stage-0-foundation`（从 `github-pages-clean2` 创建） |
| 起始 commit | `314d39cf8fe901f7f54a505552f95c44ee9e016e` |
| 起始远程基线 | `origin/master` = `5139bd989a1bbca381e51ccb75de23aabed8f5ce` |
| origin | `https://github.com/xiangshu3721/asva-workbench.git` |
| 起始工作树 | clean；没有覆盖用户未提交改动 |

## 当前版本与部署入口

- `package.json`：`asva-workbench@0.1.0`。
- GitHub Pages：`https://xiangshu3721.github.io/asva-workbench/`，基线检查 HTTP 200，页面标题为 `ASVA 工作台`。
- Pages workflow：`.github/workflows/deploy-pages.yml`，当前仅由 `master` push 或手动触发；构建时注入 CloudBase `asva-api` 地址。
- CloudBase API：`https://root-journey-prod-d4d7pzd0a8f805-1304965105.ap-shanghai.app.tcloudbase.com/asva-api`。
- CloudBase 健康基线：HTTP 200；`deepseekConfigured=true`、`feishuConfigured=true`、`authConfigured=false`。当前 `/api/health` 尚未返回 release 元数据，因此已部署代码版本记为 `UNKNOWN（待 Stage 0 health 元数据补齐）`。
- 当前公开健康响应中的 service 为 `asva-workbench`；Stage 0 会统一为目标服务标识 `asva-api`。

## 数据源与配置基线

- 前端构建配置 `VITE_API_BASE_URL` 指向 CloudBase `asva-api`；未配置时前端存在本地 demo 路径。
- 生产 Feishu 表配置存在：appointments、customers、serviceRecords、staff、products、enrollments、profileChanges。
- DeepSeek 与 Feishu 当前配置状态为已配置；`ASVA_AUTH_SECRET` 当前未配置，生产认证因此未达到 Stage 0 要求。
- 当前服务端 CORS 为 `*`，请求身份使用客户端可伪造的 `X-Staff-Id`，均列为 Stage 0 P0/P1 修复项。

## Feishu 只读快照

在任何批量测试数据动作之前，已导出当前数据到被 Git 忽略的本地目录：

`stage0-backup/feishu-snapshot-2026-10-07T11-22-54-712Z.json`

快照仅供恢复和审计，不提交到仓库、不在报告中展开记录内容。快照记录数量：appointments 12、customers 9、serviceRecords 0、staff 6、products 4、enrollments 0、profileChanges 1。

## Stage 0 验收边界

本轮只完成生产底座、调试、版本、数据模式、认证、Schema/日期契约、写入安全、遗留盘点和验收证据。12 层 Life OS、临床风险、SABC 重构、BI、今日关怀 AI、Lens、多主体、八字、CRM/营销和预约新业务均不在本轮范围内。
