# Stage 1 Migration Report

本阶段不执行 Production 批量迁移，不新增 Feishu 字段，不删除旧字段。

迁移前必须：生成 Feishu 快照；脚本幂等；输出修改前后数量、具体修改项与冲突项；出现手机号/微信号冲突时停止自动写入。

当前只完成兼容代码：`导师ID` 只读、`当前导师ID` 为唯一新写映射；旧 profile metadata 可读取，新写 metadata 使用 `_profile_version + _fields` 包装。1 条缺少联系方式的既有 Customer 保留原状，待产品确认后再处理。
