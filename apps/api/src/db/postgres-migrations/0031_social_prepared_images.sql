-- Successful preparations only; source identity survives ProductPhoto deletion.
CREATE TABLE IF NOT EXISTS social_prepared_images (
 id TEXT PRIMARY KEY NOT NULL,
 content_id TEXT NOT NULL REFERENCES social_contents(id) ON DELETE CASCADE,
 source_photo_id TEXT NOT NULL,
 source_fingerprint TEXT NOT NULL,
 recipe_version TEXT NOT NULL,
 output_path TEXT NOT NULL,
 UNIQUE(content_id, source_photo_id, source_fingerprint, recipe_version)
);
