CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_connections_channel_account
  ON marketplace_connections(channel, account_label);

CREATE UNIQUE INDEX IF NOT EXISTS idx_external_listings_channel_external
  ON external_listings(channel, external_listing_id);
