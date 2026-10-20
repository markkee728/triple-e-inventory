/* 021_reporting.sql — support for the Finance/Admin Reports module (backend/reports.js)

   Run AFTER 020_payment_terms.sql. Safe to run more than once. reports.js also runs this file by itself when the
   server starts (same pattern as the other modules), so running it by hand is optional.

   1. orders.paid_at
      An online order was "paid" on a different day than it was placed (Xendit: when the invoice settled; Cash on
      Delivery / Pickup: when the cashier collected at handover; counter payments: when the last payment landed).
      Reports need that date to put a sale on the right day, and nothing stored it. A trigger fills it in the
      moment an order becomes paid, whichever code path did it, so no application code has to change.
   2. Backfill paid_at for orders that are already paid.
   3. Indexes the reports filter and join on.                                                                    */

ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION set_order_paid_at() RETURNS trigger AS $$
BEGIN
  IF NEW.paid_at IS NULL
     AND (NEW.payment_status = 'paid' OR (NEW.total > 0 AND COALESCE(NEW.paid_amount, 0) >= NEW.total)) THEN
    NEW.paid_at := now();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orders_paid_at ON orders;
CREATE TRIGGER trg_orders_paid_at
  BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_order_paid_at();

-- Backfill, best evidence first:
--   Xendit order           -> the 'Paid' step in its status history (written when the invoice settled)
--   Cash on Delivery/Pickup-> the Delivered / Picked Up step (cash is collected at handover)
--   paid through the ledger-> the last payment received on it
--   anything else          -> the last status change, then the day it was placed
UPDATE orders o
   SET paid_at = COALESCE(
         CASE WHEN o.payment_status = 'paid' AND o.payment_method = 'Xendit'
              THEN (SELECT MIN(h.created_at) FROM order_status_history h WHERE h.order_id = o.order_id AND h.to_status = 'Paid') END,
         CASE WHEN o.payment_status = 'paid'
              THEN (SELECT MIN(h.created_at) FROM order_status_history h WHERE h.order_id = o.order_id AND h.to_status IN ('Delivered', 'Picked Up')) END,
         CASE WHEN o.total > 0 AND COALESCE(o.paid_amount, 0) >= o.total
              THEN (SELECT MAX(p.created_at) FROM payments p WHERE p.order_id = o.order_id AND p.direction = 'in') END,
         o.status_updated_at,
         o.created_at)
 WHERE o.paid_at IS NULL
   AND (o.payment_status = 'paid' OR (o.total > 0 AND COALESCE(o.paid_amount, 0) >= o.total));

CREATE INDEX IF NOT EXISTS idx_pos_sales_created        ON pos_sales (created_at);
CREATE INDEX IF NOT EXISTS idx_pos_sale_items_sale      ON pos_sale_items (sale_id);
CREATE INDEX IF NOT EXISTS idx_pos_return_items_item    ON pos_return_items (sale_item_id);
CREATE INDEX IF NOT EXISTS idx_orders_created           ON orders (created_at);
CREATE INDEX IF NOT EXISTS idx_orders_paid_at           ON orders (paid_at) WHERE paid_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_items_order        ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_created         ON payments (created_at);
CREATE INDEX IF NOT EXISTS idx_stock_movements_created  ON stock_movements (created_at);
CREATE INDEX IF NOT EXISTS idx_quotes_created_at        ON quote_requests (created_at);
