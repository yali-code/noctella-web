-- Costs written by an approved invoice cost set are EUR, but the currency was not stored.
-- Fills only that blank value; costs, stock and updated_at are unchanged.
UPDATE products SET purchase_currency = 'EUR'
WHERE purchase_currency IS NULL AND purchase_cost IS NOT NULL
  AND id IN (SELECT i.product_id FROM invoice_cost_set_items i JOIN invoice_cost_sets s ON s.id = i.cost_set_id WHERE s.status = 'approved');
