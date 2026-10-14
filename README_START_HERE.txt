TRIPLE-E INVENTORY — project with database backend

FOLDERS
  Finance_Inventory/   website (HTML/JS/CSS). Already connected: api-bridge.js is added,
                       and the login form now calls the real /api/auth/login.
  backend/             PostgreSQL schema + Node/Express API (see backend/README.md)

QUICK START (local)
  1. Install PostgreSQL and Node.js 20+.
  2. Create the DB and load it:
       sudo -u postgres psql -c "CREATE USER triplee_app WITH PASSWORD 'your-password';"
       sudo -u postgres psql -c "CREATE DATABASE triplee OWNER triplee_app;"
       psql "postgres://triplee_app:your-password@localhost/triplee" -f backend/db/001_schema.sql -f backend/db/002_seed.sql
  3. cd backend
       cp .env.example .env     (edit DATABASE_URL and set a long random JWT_SECRET)
       npm install
       npm run create-user -- "Your Name" yourusername you@triplee-metal.com 'YourP@ssw0rd' finance
       npm start
  4. Open http://localhost:8080/Login_Inventory.html

NOTE: the OTP screen is still the demo code 000000. See backend/README.md "Not done yet".


ONLINE SHOP EXTRAS (quotes, minimum order, back-in-stock, reviews)
  Code:  backend/shop-extras.js  +  Finance_Inventory/shop-extras-admin.js  (Shop_Customer.html has the customer side)
  Tables are created automatically when the server starts. backend/db/006_shop_extras.sql is the same thing for running by hand.
  .env:  QUOTE_EMAIL (optional) = where a copy of each new quote request is emailed; falls back to SHOP_EMAIL.
         Customer emails (quote received/replied, back in stock) use the same Gmail / Mailgun settings as order emails.
  Finance: menu Sales > Quote Requests and Product Reviews. Set "Minimum order" in Products > Finished Goods > Online shop details.


POS PARTIAL RETURNS (customer brings back some items of a receipt)
  Cashier: POS > Today's Sales > "Return…" on the receipt (or type an older receipt number > "Return items…"). Pick the items and quantities, choose a reason, send.
  Finance: Sales > Sales Transactions > POS Walk-in Sales > "Approve return" / "Reject". When approving, Finance says whether the items are resellable (put back in stock) or not (refund only).
  Cash sales: the refund is charged to the requesting cashier's open Cash Shift and lowers "cash that should be in the drawer". Card / online sales: no drawer cash; Finance refunds the original payment outside the POS.
  A sale that has a return cannot also be voided (return the remaining items instead). Returns are accepted for POS_RETURN_WINDOW_DAYS days after the sale (default 7, set in backend/.env).
  Audit Log: actions "Return" (requested / approved / rejected) and "Cash shift" (opened, closed with expected / counted / difference, cash added / removed).
  Tables are created automatically when the server starts. backend/db/007_pos_returns.sql is the same thing for running by hand.
