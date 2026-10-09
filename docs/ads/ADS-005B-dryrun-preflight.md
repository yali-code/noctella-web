# ADS-005B — Paid launch preflight (dry-run only)

This phase-5 provider orchestration boundary is a pure gate, not a publisher. It evaluates hypothetical readiness for Meta Ads, Google Ads or Pinterest Ads and NEVER calls any provider API, sends ads, spends money, or stores credentials.

Inputs must eventually come from independent trusted sources: a real owner approval record bound to exact product/listing/budget; verified paid provider account; freshly rechecked live provider listing availability; operational automatic ad pause; durable daily/total spend enforcement; and completed privacy/policy review. The local optimistic boolean test fixture must not be mistaken for real integrations.

This implementation deliberately returns `launchExecuted:false` and `spendAuthorized:false` even if every hypothetical gate passes. That prevents a new caller from interpreting a planning success as real launch authorization.

No production OAuth connection, no provider transport, no idempotent campaign creation, no billing, no token refresh or account-level spend caps have been built. The two Phase 5 PRs therefore close a **safe architecture slice**, not operational ad-provider activation. Activation requires explicit business approval and account credentials, with staging provider sandbox tests and a real stop/rollback workflow.
