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

NOTE: the sign-in page no longer has the demo OTP screen: after the password is accepted the user goes straight to their page.


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


CUSTOMER REGISTRATION (3 steps) + EMAIL VERIFICATION
  Page:  Finance_Inventory/Login_Inventory.html  (Create an account: Personal > Contact > Security).
  Code:  backend/auth-signup.js (sign-up, verification), backend/server.js (login gate, My Profile), Finance_Inventory/account-menu.js + shop-address.js (My Profile).
  SQL:   backend/db/008_customer_registration.sql (also run automatically when the server starts). Existing accounts are marked verified, nothing is lost.
  Email: new customers get a one-time link (expires in EMAIL_VERIFY_TTL_HOURS, default 24) and cannot sign in until they click it. Uses the same Gmail / Mailgun
         settings as order emails; without them the link is printed in the server console. EMAIL_VERIFICATION=off in backend/.env turns the requirement off.
  Cashier / Finance accounts are NOT created on this page: Finance/Admin invites them (Team > Invitations) and the role comes from the invitation.
  After sign-in:  Finance/Admin -> Finance_Inventory.html   Cashier -> POS_Cashier.html   Customer -> Shop_Customer.html
  Customers finish their profile in the shop: user menu > My Profile (name parts, birthdate, gender, company info) and the Delivery Addresses tab.
  Terms and Privacy text lives in Login_Inventory.html (LEGAL). Have it reviewed, and bump TERMS_VERSION in .env when you change it.


PRODUCTION-BASED INVENTORY DEDUCTION (Finished Goods made in-house use up Raw Materials / Finishing Supplies)
  Code:  backend/production.js  +  Finance_Inventory/production-admin.js + production.css  (small hooks in server.js, api-bridge.js, Finance_Inventory.html)
  Tables are created automatically when the server starts. backend/db/009_production.sql is the same thing for running by hand.
  1. Set up materials:  Finance > Stock In / Out > "Material requirements" (bottom of the page). Pick a Finished Good, add each Raw Material /
     Finishing Supply with the quantity needed for ONE unit, Save. Reused for every production; changing it never changes past records.
  2. Record production: Stock In > Department "Finished Goods" > product > quantity > Stock-In Source "Produced Internally".
     The material table appears: edit "Actual used" if needed, then "Confirm Production". Nothing is deducted before that button.
     Not enough stock = the confirm is blocked and nothing changes. Source "Received from Supplier" / "Inventory Adjustment" work as normal Stock In.
  3. Results: Movement log shows the material Stock-Outs ("Used in production", PRD reference, finished product, user) and the Stock-In;
     "Production history" lists every record with its material details. Reports include these movements automatically.
  Double deduction: every confirm carries a one-time key, so a double click / retry returns the same PRD record instead of deducting again.
  Manual Stock Out "Used in production" still exists for consumption NOT recorded through a production record.
