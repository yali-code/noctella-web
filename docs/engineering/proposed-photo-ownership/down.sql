-- P2-2B3D5 PROPOSED rollback for up.sql (disposable test databases only).
-- Dropping these tables discards ownership evidence. Never run it while any operation is
-- 'preparing', 'sealed' or 'review', or while capability writers may still run.
-- Media files and existing tables are untouched; retained private bytes then need operator review.
DROP INDEX IF EXISTS idx_photo_operation_artifacts_operation;
DROP INDEX IF EXISTS idx_photo_operations_state;
DROP TABLE IF EXISTS photo_operation_artifacts;
DROP TABLE IF EXISTS photo_operation_generations;
DROP TABLE IF EXISTS photo_operations;
DROP TABLE IF EXISTS photo_storage_roots;
