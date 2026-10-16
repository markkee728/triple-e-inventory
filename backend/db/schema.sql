
CREATE TABLE roles (
  role_id   SERIAL PRIMARY KEY,           -- unique ID
  name      TEXT NOT NULL                 -- e.g. 'customer', 'cashier', 'manager'
);

CREATE TABLE users (
  user_id   SERIAL PRIMARY KEY,
  role_id   INT NOT NULL REFERENCES roles(role_id),   -- FK: what kind of user
  full_name TEXT NOT NULL,
  email     TEXT NOT NULL UNIQUE,
  phone     TEXT,
  password_hash TEXT NOT NULL,            
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE customer_addresses (
  address_id SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(user_id),  -- FK: whose address
  address_line TEXT NOT NULL,
  barangay TEXT, city TEXT, province TEXT, zip_code TEXT
);

CREATE TABLE categories (
  category_id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE products (
  product_id SERIAL PRIMARY KEY,
  category_id INT REFERENCES categories(category_id), -- FK: product group
  sku        TEXT NOT NULL UNIQUE,        -- product code
  name       TEXT NOT NULL,
  unit       TEXT NOT NULL,               -- e.g. piece, kg
  cost       NUMERIC(12,2) NOT NULL,      -- what the shop pays
  price      NUMERIC(12,2) NOT NULL,      -- what the customer pays
  on_hand    NUMERIC(14,2) NOT NULL DEFAULT 0   -- how many are in stock now
);

CREATE TABLE suppliers (
  supplier_id SERIAL PRIMARY KEY,
  name  TEXT NOT NULL,
  phone TEXT,
  email TEXT
);

CREATE TABLE product_suppliers (          -- many-to-many link table
  product_id  INT REFERENCES products(product_id),
  supplier_id INT REFERENCES suppliers(supplier_id),
  PRIMARY KEY (product_id, supplier_id)   -- a product can have many suppliers and vice versa
);

CREATE TABLE stock_movements (            -- every item that comes in or goes out
  movement_id SERIAL PRIMARY KEY,
  product_id  INT NOT NULL REFERENCES products(product_id),
  supplier_id INT REFERENCES suppliers(supplier_id),  -- only for stock coming in
  direction   TEXT NOT NULL CHECK (direction IN ('in','out')),
  quantity    NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE orders (                     -- online orders
  order_id    SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES users(user_id),
  fulfillment TEXT NOT NULL CHECK (fulfillment IN ('Delivery','Pickup')),
  status      TEXT NOT NULL DEFAULT 'Pending Confirmation',
  total       NUMERIC(12,2) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE order_items (                -- the products inside an order
  item_id    SERIAL PRIMARY KEY,
  order_id   INT NOT NULL REFERENCES orders(order_id),
  product_id INT NOT NULL REFERENCES products(product_id),
  qty        NUMERIC(14,2) NOT NULL CHECK (qty > 0),
  price      NUMERIC(12,2) NOT NULL       -- price at the time of buying
);

CREATE TABLE product_reviews (
  review_id  SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(product_id),
  user_id    INT NOT NULL REFERENCES users(user_id),
  rating     SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body       TEXT
);

CREATE TABLE pos_sales (                  -- sales at the store counter
  sale_id    SERIAL PRIMARY KEY,
  cashier_id INT REFERENCES users(user_id),
  method     TEXT NOT NULL CHECK (method IN ('Cash','Card','Xendit')),
  total      NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE pos_sale_items (             -- the products on a counter receipt
  item_id    SERIAL PRIMARY KEY,
  sale_id    INT NOT NULL REFERENCES pos_sales(sale_id),
  product_id INT NOT NULL REFERENCES products(product_id),
  qty        NUMERIC(14,2) NOT NULL CHECK (qty > 0),
  price      NUMERIC(12,2) NOT NULL
);