# Stage 2 Data Quality

运行 `npm run evidence:data-check`。检查 Source 的 Customer/Subject、content_hash、枚举与重复；Evidence 的 Source/Subject/枚举；Proposal 的 Evidence 引用；Conflict 的 Evidence 引用；Confirmed Evidence 的 Reviewer；以及重复导入和 Source 处理状态。

检查脚本不输出 raw_text、source_excerpt 全文或家庭/心理内容。
