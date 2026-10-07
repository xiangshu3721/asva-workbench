# Release Management

- `release.json` 是可审计单调计数器，当前起点为 `0`。
- `npm run release:prepare` 只递增计数、生成 metadata、打印 `Release Rxxx prepared`，不部署。
- `npm run build` 自动生成 `build-meta.json`、前端 public metadata 和 CloudBase bundle metadata。
- metadata 包含 appVersion、releaseCounter、release、gitCommit、gitBranch、buildTime、environment。
- FE 在 Debug Drawer 比对 FE/BE releaseCounter，显示 `VERSION_MATCH` / `VERSION_MISMATCH` / `UNKNOWN`。
- `/api/health` 返回相同元数据；FE/BE 同一 release counter 才允许 Stage 0 release 验收。
