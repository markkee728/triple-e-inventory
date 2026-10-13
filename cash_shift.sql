CREATE TABLE IF NOT EXISTS pos_cash_shifts (
 shift_id BIGSERIAL PRIMARY KEY,
 cashier_id INT NOT NULL REFERENCES users(user_id),
 cashier_name TEXT NOT NULL,
 opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 closed_at TIMESTAMPTZ,
 opening_cash NUMERIC(12,2) NOT NULL CHECK (opening_cash >= 0),
 closing_cash NUMERIC(12,2) CHECK (closing_cash >= 0),
 closing_note TEXT NOT NULL DEFAULT '',
 CHECK (closed_at IS NULL OR closing_cash IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift_per_cashier ON pos_cash_shifts(cashier_id) WHERE closed_at IS NULL;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS cash_shift_id BIGINT REFERENCES pos_cash_shifts(shift_id);
CREATE INDEX IF NOT EXISTS pos_sales_cash_shift_idx ON pos_sales(cash_shift_id);
