# Login response-shape regression and optional metadata writes

Feishu's records search response encodes text fields as segments, while its list response returns strings. The password credential adapter previously discarded segments, losing both the staff identity and password hash. Decode text segments without changing password verification, identity matching, session signing, or rate limits.

After successful authentication, attempt the last-login timestamp update without waiting for it. Log a fixed, non-sensitive failure event when it rejects. This timestamp is best-effort: a serverless instance may freeze after responding; it is not a durable login audit log.

The patch is based on master `7379a7f` and independently applies to deployed candidate `6b5c075` (PR #80). The latter's search lookup code remains outside this PR. Do not merge PR #80 or replace the deployed candidate with a master build as a side effect of applying this fix. Production release and duplicate Staff cleanup require separate approval.

Validation: typecheck, complete test suite (79 files / 657 tests), frontend build, CloudBase build. The eight added regression cases also pass against deployed candidate `6b5c075` with the same patch. Without the patch, the deployed candidate fails five of those cases. All password fixtures are synthetic and all provider responses are isolated mocks; no production login or data mutation was performed.

Remaining work outside this urgent patch: reject ambiguous duplicate credentials, guard management writes to duplicate Staff identities, verify provider-side concurrent creation and long-term idempotency, and approve an exact duplicate-data cleanup plan. No production recovery is claimed until the user validates a separately approved release.
