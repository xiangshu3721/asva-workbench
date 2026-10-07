# Field Provenance V1

字段来源沿用 `profile_field_meta_json`，统一形态为：

```json
{
  "_profile_version": 3,
  "_fields": {
    "marital_status": {
      "source": "ADMIN_CONFIRMED",
      "confidence": 1,
      "confirmed": true,
      "updatedAt": "2026-10-07T10:00:00.000Z"
    }
  }
}
```

正式来源枚举：`STRUCTURED_INPUT`、`USER_EXPLICIT`、`ADMIN_CONFIRMED`、`MENTOR_FACTUAL_INPUT`、`AI_EXTRACTED_CONFIRMED`、`IMPORTED_HISTORY`、`LEGACY_MIGRATION`。兼容读取旧 `MENTOR_CONFIRMED`、`MENTOR_OBSERVATION`、`AI_INFERENCE`，但未确认 AI 推断不能与人工确认事实同等级。

每次重要 Customer 更新：记录 old/new、source、operator、changed_at、confirmed，并将 `_profile_version` 加 1。版本是 Customer 档案版本，不使用 Release Counter。
