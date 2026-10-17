# F1/F2 source-first scope freeze (#462)

Base: `60a45569e19bf11d7af67123509d04d8dea3684b`. Prior reproduction evidence: PR #461 at `bc1c91c15ec27c7767441f75510fa88c9907c7e5`.

Verified source before consulting any new worker conclusions: shared live-used `photoOperationAuthority.ts:105-110` still separates lstat from pathname streaming; inactive W11 `:118-137` links outside the ownership transaction. PR #461 reproduces these exact defects. W11's production refusal and proposal-only 0042 remain intact. No new worker report was read.

Authorized deliverable is test-only helpers/harnesses, hostile tests, design and proposed integration diff. Do not edit `src/`, register/apply 0042, activate, merge or deploy. `AGENTS.md`/`LOOP.md` absent in base; follow the user-supplied loop. Progress remains 4/12.

F1 prototype must bind bytes/stat to one descriptor and reject observed path/root swaps. Root/ancestor rename authority and inode write authority must be explicitly trusted: portable Node path APIs cannot prove containment against a malicious same-UID actor that swaps and restores ancestors between observations.

F2 prototype will use an operation lock held across filesystem publication and DB transition; lease controls entry, a granted publication is pinned until commit/rollback. This is a proposed semantic choice, NOT current W11 behavior. Reclaim must serialize on that same guard. Retained immutable per-generation seals provide provenance after a post-link rollback. Test fixture tables are not migration 0042.
