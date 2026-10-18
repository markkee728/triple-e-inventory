-- Quote requests are now Reservations or Pre-orders, and every request has an item type.
--   Reservation = a catalog product whose whole quantity is in stock (we set it aside)
--   Pre-order   = not enough stock, or a custom item that we make / order for the date asked
-- The server decides this when the request is saved. shop-extras.js also adds these columns on start, so running this by hand is optional.
-- Older requests keep NULL here and simply show no tag.
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS request_type TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS item_type TEXT;
