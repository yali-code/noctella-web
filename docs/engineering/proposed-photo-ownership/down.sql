-- P2-2B3D5 PROPOSED rollback for up.sql (disposable test databases only).
-- Dropping these tables discards ownership evidence. Never run it while any operation is
-- 'preparing', 'sealed' or 'review', or while capability writers may still run.
-- Media files and existing tables are untouched; retained private bytes then need operator review.
-- Apply as ONE transaction (BEGIN ... COMMIT / psql -1); do not partially discard ownership evidence.
-- 0041 W2 intents can reference 0040 photo_operations; remove the dependent 0041 objects first.
-- Dropping W2 intents irreversibly discards request idempotency history: owner-approved rollback only.
DROP INDEX IF EXISTS idx_photo_w2_upload_intents_product;
DROP TABLE IF EXISTS photo_w2_upload_intents;
DROP INDEX IF EXISTS idx_photo_operation_artifacts_operation;
DROP INDEX IF EXISTS idx_photo_operations_state;
DROP TABLE IF EXISTS photo_operation_artifacts;
DROP TABLE IF EXISTS photo_operation_generations;
DROP TABLE IF EXISTS photo_operations;
DROP TABLE IF EXISTS photo_storage_roots;
