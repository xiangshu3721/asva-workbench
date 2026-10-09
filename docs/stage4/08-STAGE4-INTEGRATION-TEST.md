# Stage 4 Integration Test

The automated integration boundary is code-only in this turn. Shared contract tests exercise context selection, redaction, current/historical separation, hypothesis isolation, grounding, diagnosis prevention, knowledge gaps and fingerprint changes. Server syntax and TypeScript checks cover the API wiring.

Real DeepSeek acceptance must use a controlled `STAGE4_IT_<timestamp>` context or an explicitly authorized real customer. It must send only the structured context and safe evidence summaries; it must not send names, phone numbers, WeChat IDs or complete Source text.
