# Understanding Context Builder

`buildCustomerUnderstandingContext` consumes materialized structured data rather than raw Source text. It returns current snapshot, profile domains, life events, current goals and needs, self meanings, observations, resources, open conflicts, coverage gaps and compact evidence references.

Selection is bounded and deterministic: confirmed evidence first, then evidence type, confidence, current relevance and recency. Hypotheses are isolated from the main confirmed context. Direct phone, WeChat, mentor identifiers and customer name are excluded from the DeepSeek context.
