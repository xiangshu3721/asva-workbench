# Stage 1 Migration Report

本阶段不执行 Production 批量迁移，不删除旧字段。`出生日期` 已按授权在真实 Customers 表创建为 DateTime；旧 `导师ID` 不删除，继续只读兼容并标记 deprecated。

迁移前必须：生成 Feishu 快照；脚本幂等；输出修改前后数量、具体修改项与冲突项；出现手机号/微信号冲突时停止自动写入。

当前迁移边界：`导师ID` 只读、`当前导师ID` 为唯一新写映射；旧 profile metadata 可读取，新写 metadata 使用 `_profile_version + _fields` 包装。最终数据质量已通过，指定历史残留已按快照删除，ASVA TEST DATASET V1 未触碰。
