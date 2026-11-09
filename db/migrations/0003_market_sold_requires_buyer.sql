-- Northfall Phase 5: a sold market listing must have a buyer.
-- Found by the concurrency review (a 'sold' listing without buyer_uid was accepted).
-- The importer maps legacy sold listings without a buyer to 'cancelled' and reports them.
BEGIN;
ALTER TABLE market_listings
  ADD CONSTRAINT chk_market_sold_has_buyer
  CHECK (status <> 'sold' OR buyer_uid IS NOT NULL);
COMMIT;
