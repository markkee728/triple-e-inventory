-- 022_enable_partial_terms.sql — switch Half (50%) and Down (30%) payment ON for ready-stock and made-to-order.
--
-- 020_payment_terms.sql ships only Full Payment enabled, so customers and cashiers see just "Full" until Finance
-- turns the others on. This file does that in one step (same effect as ticking them in Finance > Sales > Payment terms).
-- Safe to run more than once. Percentages are untouched: edit them on the Payment terms screen if management wants
-- different numbers. 'custom' stays OFF (Finance-only, set per quotation).

BEGIN;
UPDATE payment_terms
   SET enabled = TRUE,
       retail_allowed = TRUE,
       made_to_order_allowed = TRUE,
       note = COALESCE(note, 'Switched on for all order types by script 022'),
       enabled_at = COALESCE(enabled_at, now()),
       updated_at = now()
 WHERE term_key IN ('half', 'down');
COMMIT;
