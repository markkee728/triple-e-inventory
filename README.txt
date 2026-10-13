TRIPLE-E CASH SHIFT INSTALLATION
================================
IMPORTANT: This is an ADD-ON, not a replacement for your current project. Back up your repository/database first.

1. Copy install_cash_shift.py, cash-shifts.js, cash-shift-ui.js, cash_shift.sql into the ROOT of your current Git repository.
2. Run: python install_cash_shift.py
   The installer modifies Finance_Inventory/POS_Cashier.html, backend/server.js, backend/pos-shop.js, makes .cashshift.bak backups, and copies the new JS and SQL files into their locations.
3. Execute backend/db/003_cash_shift.sql ONCE against the existing Cloud SQL PostgreSQL database. Example with psql: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/db/003_cash_shift.sql (use your own secure DB connection; never paste credentials into chat).
4. Restart Node backend and test on staging BEFORE deploying to production.
5. Sign in as Cashier -> Cash Shift -> Open Shift. Then make a CASH sale -> Cash Shift -> Close Shift. Confirm expected cash = opening cash + completed, non-voided cash sales.
6. Finance users can GET /api/pos/cash-shifts/history (authenticated) for all cashier shift history. Cashiers see only their own. To view as Finance/Admin without code, use the included Finance_Cash_Shifts.html page placed inside Finance_Inventory and open it from Finance/Admin session.
7. Deploy your tested changes using your existing Cloud Run build/deploy workflow; git push alone does NOT guarantee deployment unless CI/CD is configured.

NOTES:
- Uses existing pos_sales data; excludes Voided sales; card and Xendit do not count as physical cash.
- Sales require an open shift, including manual Card sales. Xendit checkout has a separate async flow and is not linked to a shift; it does not affect cash totals. A pending Xendit checkout does not block closing a shift.
- Only opening cash + cash sales are supported. Cash paid-outs/refunds are NOT included. Do not use this as final accounting if you need paid-outs/refunds; add cash movement records first.
- Historical POS sales from before this migration have no shift ID and are not retroactively assigned.
- Only one open shift per cashier; concurrent open/close/sale actions are serialized with a PostgreSQL advisory transaction lock.
- Schema must be applied before starting new code. If your current code differs from the archive version used for integration, the installer may refuse to patch; do not force it.
- Never commit .cashshift.bak backups, secrets, or database connection strings.
