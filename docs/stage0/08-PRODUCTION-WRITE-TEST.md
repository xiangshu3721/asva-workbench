# Production Write Test

本文件是执行记录模板。真实写入必须使用 `STAGE0_TEST_` 前缀，并在执行前确认 `stage0-backup/` 快照存在。

## 流程

1. Mentor：CREATE → READ → UPDATE → DEACTIVATE。
2. Customer：CREATE → READ → UPDATE（nickname/phone/wechat/city/occupation/referrer/source）→ refresh。
3. Enrollment：单课程和多课程报名 → refresh。
4. ServiceRecord A：普通记录 → refresh。
5. ServiceRecord B：AI summary + profile update + ProfileChange → refresh。
6. Profile：city 南京 → 杭州，确认客户、服务记录、ProfileChanges 均可追溯。

## 结果边界

- 每次结果记录 HTTP 状态、request_id、release、数据源、Feishu record_id；不记录密钥、OTP、完整聊天正文。
- 部分失败必须返回 partial failure，不得标记 full success。
- 创建动作应携带 operation_id/idempotency key，重试不得重复造记录。
- 该模板未代替本轮实际生产写入结果；真实执行需在配置 `ASVA_AUTH_SECRET` 和确认可写环境后进行。
