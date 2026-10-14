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
