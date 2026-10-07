# Data Mode

## 两种模式

`DATA_MODE` 只允许 `production` 或 `demo`。

- `production`：页面只调用真实 API；API/CloudBase/Feishu 失败时显示错误，不读取 localStorage、seed 或 mock 作为业务回退。
- `demo`：允许本地 seed/localStorage，页面必须显示 Demo 语义；不得调用生产写入 API。

前端由 `VITE_DATA_MODE` 显式控制；未设置时，有 `VITE_API_BASE_URL` 视为 production，否则视为 demo。服务端生产部署强制注入 `DATA_MODE=production`。

## 已盘点的回退点

| 位置 | 回退 | Stage 0 处理 |
|---|---|---|
| `src/App.tsx` | 无远程地址时使用本地 repository | 仅在 demo 允许；production 无 API 时保持连接失败态 |
| `src/repositories.ts` | localStorage + seed | 仅 demo |
| `src/clientApi.ts` | local async API | 仅 demo |
| `server/repository.mjs` | Feishu 读取/写入 | production 唯一业务数据源 |
| AI 摘要/Brief | 本地确定性函数 | 仅 demo；production 由服务端 AI 路由处理 |

## 验收

- production：Feishu/CloudBase 不可用时不是 200 假成功、不使用本地 seed。
- demo：显示 Demo 语义，任何写入都不触达生产 API。
