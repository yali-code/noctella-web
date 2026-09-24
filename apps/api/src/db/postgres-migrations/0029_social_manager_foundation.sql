
-- Editorial content only; approval has no publishing side effects.
CREATE TABLE IF NOT EXISTS social_contents (
 id TEXT PRIMARY KEY,
 platform TEXT NOT NULL DEFAULT 'instagram' CHECK (platform = 'instagram'),
 account_label TEXT NOT NULL DEFAULT 'vault' CHECK (account_label = 'vault'),
 content_type TEXT NOT NULL CHECK (content_type IN ('post','reel','story')),
 status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready_for_review','approved','rejected')),
 caption TEXT NOT NULL DEFAULT '',
 product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
 version INTEGER NOT NULL DEFAULT 1,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_social_contents_queue ON social_contents(status, content_type, updated_at);
CREATE TABLE IF NOT EXISTS social_content_media (
 id TEXT PRIMARY KEY,
 content_id TEXT NOT NULL REFERENCES social_contents(id) ON DELETE CASCADE,
 photo_id TEXT REFERENCES product_photos(id) ON DELETE SET NULL,
 sort_order INTEGER NOT NULL,
 UNIQUE(content_id, photo_id),
 UNIQUE(content_id, sort_order)
);
CREATE INDEX IF NOT EXISTS idx_social_content_media_photo ON social_content_media(photo_id);
