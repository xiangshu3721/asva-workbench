# Provenance V2

Stage 1 的 `source`、`confirmed`、`confidence`、`updated_at` 保持兼容。Stage 2 新增可选 `source_record_id`、`evidence_id`、`extraction_batch_id`；ProfileChanges 新增 `source_record_id`、`evidence_id`、`update_batch_id`。

人工确认后继续复用 `persistCustomerProfile` / CustomerUpdateService，因此仍然执行 normalize、profile_version、Field Provenance、ProfileChanges 与 updated_at。手动编辑 Customer 仍可使用 `STRUCTURED_INPUT + ADMIN_CONFIRMED`，无需先创建 Source。
