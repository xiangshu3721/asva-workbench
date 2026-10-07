# Debug Mode

- 默认关闭；支持 `?debug=1`，或点击左下版本信息 5 次开启。
- 状态只写 `localStorage.asva_debug_enabled=true`；不改变权限，不绕过麦克风/业务权限。
- Debug Drawer 仅 ADMIN 可见，包含 FE/BE release、environment、feature flags、认证安全摘要、数据源、最近 20 条 API 请求和安全错误信息。
- 请求记录在内存，字段为时间、method、path、status、duration、request_id、result；不保存 body/token。
- 生产日志包含 timestamp/request_id/operator_id/operation/entity/entity_id/status/duration/error_code，不包含完整手机号、聊天正文、OTP、JWT、secret。
