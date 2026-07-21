# CLAUDE.md

# Noctella ERP AI Operating Protocol

This file contains the permanent operating rules for AI agents working in this repository.

---

# PRIMARY OBJECTIVE

Protect:

- architecture
- business rules
- inventory integrity
- data consistency

Correctness always has priority over speed.

Production code is the source of truth.

---

# ECONOMY MODE

Economy Mode is the default operating mode.

Principles:

- Inspect only the files required for the current task.
- Prefer targeted inspection over repository-wide searches.
- Expand inspection only when necessary to verify architecture, business rules, inventory integrity, or correctness.
- Implement the smallest sufficient change.
- Avoid unnecessary abstractions.
- Avoid unnecessary refactoring.
- Do not modify unrelated code.
- Stop once the requested work is complete.

Task lifecycle:

Understand

↓

Inspect

↓

Implement

↓

Validate

↓

Stop

---

# RESPONSE STYLE

Default response format:

Status

Files Modified

Validation

Risk

Next Step

Keep responses concise.

---

# ARCHITECTURE

Application flow:

Route

↓

Application Service

↓

Use Case

↓

Repository

Rules:

- Business logic belongs only in Use Cases.
- Repositories perform persistence only.
- Application Services orchestrate only.
- Routes validate input and delegate.
- Never bypass the canonical Use Case.
- Never duplicate business logic.

---

# INVENTORY

Inventory integrity has the highest priority.

Always use the canonical inventory workflow.

Never introduce alternative stock mutation paths.

Preserve:

- atomicity
- idempotency
- optimistic concurrency

---

# TRANSACTIONS

SQLite

- synchronous
- better-sqlite3 transaction callbacks must never return Promises

PostgreSQL

- asynchronous
- await transaction operations

Never mix the two transaction models.

---

# IMPLEMENTATION RULES

Before changing code:

- understand the existing implementation
- modify existing code whenever reasonable
- prefer simple solutions
- avoid duplication
- avoid speculative improvements
- stay within requested scope

---

# REPOSITORY LAYOUT

Primary application folders:

- apps/api
- apps/admin
- apps/storefront
- packages
- docs

Search locally before expanding scope.

---

# GIT

Never perform without explicit user instruction:

- commit
- push
- merge
- rebase
- reset
- stash
- checkout
- branch deletion

Never discard user work.

---

# VALIDATION

Never claim success without validation.

Validation order:

1. affected tests
2. typecheck
3. build
4. lint
5. broader validation only if required

Typical commands:

```bash
npm run typecheck --workspaces
npm run build --workspaces
npm test --workspaces
npm run lint -w apps/admin
```

Report only:

- PASS
- FAIL
- NOT RUN
- BLOCKED

Never invent results.

---

# DECISION ESCALATION

Stop and ask the user when:

- architecture would change
- business rules are ambiguous
- inventory behavior would change
- schema or migrations are required
- multiple architecture-level implementations are equally valid
- requested scope is unclear

Do not stop for minor implementation details.

---

# PROJECT RULES

Marketplace-specific fields remain optional during product creation.

Inventory entry requires only minimum inventory fields.

Marketplace validation occurs only during publishing.

EUR is the default internal currency.

Prefer shared workflows over duplicated implementations.

---

# READY FOR PR

Never commit.

Never push.

Never prepare a pull request.

Wait until the user explicitly says:

READY FOR PR

---

# COMPLETION CHECKLIST

Before finishing verify:

- requested change completed
- architecture preserved
- no unrelated modifications
- validation completed or reported
- no Git write operations performed

Finish with:

IMPLEMENTATION COMPLETE — WAITING FOR REVIEW
