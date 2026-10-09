# Stage 5｜API 与 UI 边界

## API

- `GET /api/customers/:id/safety-assessment`
- `POST /api/customers/:id/safety-assessment/refresh`

读取需要登录；刷新需要 ADMIN。非法、过期 Session 仍由现有 `requireAuth`/Session 链路处理。

## 状态

安全评估使用 `FRESH/STALE/PROCESSING/FAILED`。资料处理完成或可靠档案变化后只标记 `STALE`，不自动调用模型。相同 fingerprint、prompt version 和规则版本下重复刷新不重复调用；显式 `force` 才重新处理。

## 前端

Customer Detail 在业务信息之前显示“服务安全边界”卡片，用人话展示下一步、服务提醒和关键未知；默认不展示 R0-R4、内部规则命中、内部 ID、手机号、微信号或完整 Token。它明确写明不是诊断或治疗结论。

## 日志

日志只允许 request、操作、状态和安全错误码，不允许姓名、手机号、微信号、完整安全引文、完整上下文或 Secret。

