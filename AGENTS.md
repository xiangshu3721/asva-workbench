# ASVA AI 接手规则

本文件是当前仓库的最小协作入口；不替代 README、测试、发布文档或 GitHub 权限。开始任何任务前先读取：

1. 当前 GitHub Issue、目标 PR 和实际基线分支；
2. [README.md](README.md)；
3. [CloudBase API 发布规则](docs/CLOUDBASE_API_RELEASE.md)；
4. 当前 `.github/workflows/` 与受影响代码的测试。

## 任务交接与范围

- 一个工程任务对应一个 GitHub Issue；Issue 写清目标、非目标、允许范围、验收标准、已知未知项与生产授权。
- Codex 从 Issue 接手，先核对实际代码、分支、工作区状态和当前 workflow；不以聊天摘要、旧 SHA、旧部署记录或旧任务作为事实。
- 在独立分支修改，以 PR 交付。PR 必须链接 Issue，并列出改动文件、基线与结果 commit、执行命令、测试结果、未验证项、偏差和阻断。
- 需求冲突、范围扩大、工作区冲突、生产状态不明或授权不足时，停止相关操作并在 Issue/PR 标记 `BLOCKED`；不 reset、clean、覆盖或改路线。

## 默认权限边界

默认允许：只读核查、文档或代码变更、自动化测试、独立分支和 Draft PR。

默认禁止：合并 PR、修改/删除生产数据、生产部署、触发发布 workflow、写入真实客户或飞书数据、修改生产配置、提交密钥/Token/Cookie/未脱敏客户资料。

需要生产、真实外部写入、Staging/Production 部署、合并或回滚时，必须由 Issue 或用户消息明确授权，并在 PR 回执中附相应证据。

## 测试与验收

- 代码改动至少运行与范围匹配的 `npm run typecheck`、`npm test`、`npm run build` 及受影响模块的现有测试；不得把未运行的命令写成通过。
- 涉及真实集成时，先遵守 README 的独立 Staging、synthetic data 与人工验收要求；Production 不是功能测试环境。
- Mock、HTTP 200、截图或执行者自报 PASS 不能单独证明真实数据、外部服务或 Production 可用。
- 验收证据应可复核，至少说明环境、时间、命令/测试、commit 或 PR；FAIL、NOT_TESTED、BLOCKED 和风险必须保留。

## 发布保护

- 当前 `master` push 会自动发布 GitHub Pages。**任何合并到 `master` 的 PR（含纯文档）都必须先获得明确的生产 Pages 发布授权；没有授权就保持 Draft 或 Ready but unmerged。**
- CloudBase API 发布只允许依照 [CloudBase API 发布规则](docs/CLOUDBASE_API_RELEASE.md) 的受控手动 workflow 执行；不得用本机部署命令、普通 push 或本文件替代发布授权。
- 不运行 `npm run deploy:cloudbase`、`npm run deploy:cloudbase:worker`、`npm run deploy:cloudbase:all` 或任何 GitHub Actions 发布 workflow，除非任务已单独授权并满足上述发布文档。
- 若仓库规则、workflow 或环境保护比本文件更严格，以更严格者为准。

## 维护原则

本文件只记录稳定的协作规则。易变的分支 SHA、部署状态、客户数据、密钥和历史任务留在对应 Issue、PR、受控环境或审计记录中，不写入这里。
