# ASVA Stage 2 Baseline

基线：Production R003，FE/BE `VERSION_MATCH = YES`。Stage 2 开发期间不增加 Release Counter，不自动发布 R004。

Stage 1 的 Customer Current Snapshot、CustomerUpdateService、Profile Version、Field Provenance、ProfileChanges、Enrollment 与 Auth 均视为冻结依赖。既有 Customer 不逆向生成假 Evidence，历史资料继续按 `LEGACY_CONFIRMED_SNAPSHOT` 解释。

本阶段只建立 Evidence & Customer Evolution Foundation V1：原始资料保存、原子证据、候选档案更新、冲突、人工审核和可追溯 Provenance。
