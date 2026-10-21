/* pricing.js — automatic prices, so nobody has to work them out by hand.

   1. Finished goods: selling price = unit cost x (1 + markup %). Markup is 20% by default (Finance can change it).
      A database trigger keeps the price right whenever the unit cost changes, from ANY screen or job, so it never goes stale.
      A product can be switched to a manual price (price_auto = false) when there is a reason; the trigger then leaves it alone.

   2. Custom made-to-order quotes: a calculator works the price out from the request itself.
        weight per piece   from the size: a size range (table), a pipe size (table) or typed dimensions (volume x density x fill)
        material           weight x (1 + scrap %) x price per kg of the raw material in stock (its current unit cost)
        process            casting / forging / fitting work per kg (with a minimum per piece)
        finish             per kg (with a minimum per piece) — powder coat, plating, polishing ...
        service            per piece — deburring, drilling, CNC, threading
        tooling            one-time mould / die cost for the order, shared by every piece
        cost per piece     the sum;   price per piece = cost x (1 + quote markup %), rounded up to the next peso
      The cashier sees it as the suggested price (already filled in), the customer sees an estimate on the request form,
      and Finance sees the system price next to the cashier's. A cashier price BELOW the computed cost always goes to Finance.
   Every rate lives in one row (pricing_rules) that Finance edits on the Products page ("Pricing rules"). */
module.exports = function ({ app, pool, auth, wrap, tx, audit, ValidationError, str }) {
  const FG = 'Finished Goods';
  const DEFAULT_RATES = {
    density: { Aluminum: 2.7, Brass: 8.5 },                                       // g/cm3
    fillFactor: 0.35,                                                               // a cast / forged part is not a solid block
    rangeWeightKg: { 'Small': 0.08, 'Medium': 0.45, 'Large': 2.0, 'Extra large': 7.5 },     // aluminum; brass is scaled by density
    pipeWeightKg: { '1/4"': 0.06, '3/8"': 0.09, '1/2"': 0.14, '3/4"': 0.22, '1"': 0.36, '1-1/4"': 0.55, '1-1/2"': 0.75, '2"': 1.2 },
    materialSku: { 'Aluminum ADC12': 'RM-ADC12', 'Aluminum A380': 'RM-ADC12', 'Brass C37700': 'RM-C377', 'Brass C36000': 'RM-C377' },
    materialPerKgFallback: { Aluminum: 150, Brass: 420 },                          // used only if the raw material is not in stock records
    scrapPct: 10,
    processPerKg: { 'Die-cast part': 60, 'Forged part': 80, 'Fitting / valve': 90 },
    processMinPerPc: 10,
    finishPerKg: { 'Raw / Unfinished': 0, 'Shot Blasted': 15, 'Powder Coated': 45, 'Painted': 35, 'Chromate Conversion': 30, 'Polished': 40,
                   'Satin / Brushed': 30, 'Nickel Plated': 90, 'Chrome Plated': 120 },
    finishMinPerPc: 5,
    servicePerPc: { 'None (as is)': 0, 'Deburring': 8, 'Drilling / tapping': 25, 'CNC machining': 120, 'Threading (BSP / NPT)': 30 },
    toolingPerOrder: { 'Die-cast part': 8000, 'Forged part': 5000, 'Fitting / valve': 0 },
    thicknessRefMm: 3
  };
  const ITEM_FAMILY = { 'Die-cast part': 'Aluminum', 'Forged part': 'Brass', 'Fitting / valve': 'Brass' };
  const FAMILY_DEFAULT = { Aluminum: 'Aluminum ADC12', Brass: 'Brass C37700' };
  const PIPE_IN = { '1/4"': 0.25, '3/8"': 0.375, '1/2"': 0.5, '3/4"': 0.75, '1"': 1, '1-1/4"': 1.25, '1-1/2"': 1.5, '2"': 2 };
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  /* ---------- database ---------- */
  async function ensure() {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS pricing_rules (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        fg_markup_pct NUMERIC(6,2) NOT NULL DEFAULT 20 CHECK (fg_markup_pct >= 0 AND fg_markup_pct <= 500),
        quote_markup_pct NUMERIC(6,2) NOT NULL DEFAULT 20 CHECK (quote_markup_pct >= 0 AND quote_markup_pct <= 500),
        rates JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_by INT REFERENCES users(user_id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query(`INSERT INTO pricing_rules (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
      const had = (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'price_auto'`)).rowCount;
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS price_auto BOOLEAN NOT NULL DEFAULT TRUE`);
      await pool.query(`CREATE OR REPLACE FUNCTION fg_auto_price() RETURNS trigger AS $$
        DECLARE m NUMERIC;
        BEGIN
          IF NEW.department = 'Finished Goods' AND NEW.price_auto THEN
            SELECT fg_markup_pct INTO m FROM pricing_rules WHERE id = 1;
            NEW.selling_price := round(COALESCE(NEW.unit_cost, 0) * (1 + COALESCE(m, 20) / 100.0), 2);
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await pool.query(`DROP TRIGGER IF EXISTS trg_fg_auto_price ON products`);
      await pool.query(`CREATE TRIGGER trg_fg_auto_price BEFORE INSERT OR UPDATE OF unit_cost, price_auto, department, selling_price ON products
        FOR EACH ROW EXECUTE FUNCTION fg_auto_price()`);
      // first start with this feature: every finished good is priced from its cost (touching unit_cost fires the trigger)
      if (!had) await pool.query(`UPDATE products SET unit_cost = unit_cost WHERE department = 'Finished Goods' AND price_auto`);
      // quote_requests.suggested_amount / suggested_cost are added by shop-extras.js, which creates that table
      return true;
    } catch (err) { console.warn('[pricing] setup failed:', err.message); return false; }
  }
  const ready = ensure();

  async function rules(db) {
    await ready;
    const r = (await (db || pool).query('SELECT fg_markup_pct, quote_markup_pct, rates, updated_at, u.full_name AS updated_by FROM pricing_rules LEFT JOIN users u ON u.user_id = pricing_rules.updated_by WHERE id = 1')).rows[0] || {};
    const saved = r.rates || {};
    const rates = {};
    Object.keys(DEFAULT_RATES).forEach((k) => {
      const d = DEFAULT_RATES[k];
      rates[k] = d && typeof d === 'object' ? Object.assign({}, d, saved[k] && typeof saved[k] === 'object' ? saved[k] : {}) : (saved[k] != null ? saved[k] : d);
    });
    return { fgMarkupPct: r.fg_markup_pct == null ? 20 : +r.fg_markup_pct, quoteMarkupPct: r.quote_markup_pct == null ? 20 : +r.quote_markup_pct,
      rates, updatedAt: r.updated_at || null, updatedBy: r.updated_by || null };
  }
  async function materialPrices(db, rates) {
    const skus = [...new Set(Object.values(rates.materialSku))];
    const { rows } = await (db || pool).query(`SELECT sku, name, unit, unit_cost FROM products WHERE sku = ANY($1) AND NOT is_archived`, [skus]);
    const by = new Map(rows.map((x) => [x.sku, x]));
    const out = {};
    Object.keys(rates.materialSku).forEach((m) => {
      const p = by.get(rates.materialSku[m]), fam = /^Brass/.test(m) ? 'Brass' : 'Aluminum';
      const perKg = p && String(p.unit).toLowerCase() === 'kg' && +p.unit_cost > 0 ? +p.unit_cost : +rates.materialPerKgFallback[fam];
      out[m] = { perKg, from: p && String(p.unit).toLowerCase() === 'kg' && +p.unit_cost > 0 ? p.name + ' (' + p.sku + ') unit cost' : 'standard rate (no stock price found)' };
    });
    return out;
  }

  /* ---------- the quote calculator ---------- */
  const toMm = (v) => {
    const unit = (/(mm|cm|inches|inch|in|")\s*$/i.exec(v) || [])[1] || 'mm', f = /^mm$/i.test(unit) ? 1 : /^cm$/i.test(unit) ? 10 : 25.4;
    return (String(v).replace(/(mm|cm|inches|inch|in|")\s*$/i, '').match(/\d+(?:[-\s]\d+\/\d+|\/\d+|\.\d+)?/g) || []).map((t) => {
      const mx = /^(\d+)[-\s](\d+)\/(\d+)$/.exec(t), fr = /^(\d+)\/(\d+)$/.exec(t);
      return (mx ? +mx[1] + mx[2] / mx[3] : fr ? fr[1] / fr[2] : +t) * f;
    });
  };
  function pipeWeight(rates, size) {
    if (rates.pipeWeightKg[size] != null) return { kg: +rates.pipeWeightKg[size], basis: 'standard weight of a ' + size + ' fitting' };
    const mm = toMm(size)[0];
    if (!(mm > 0)) return null;
    const inch = mm / 25.4, pts = Object.keys(PIPE_IN).map((k) => [PIPE_IN[k], +rates.pipeWeightKg[k]]).sort((a, b) => a[0] - b[0]);
    let kg;
    if (inch <= pts[0][0]) kg = pts[0][1] * Math.pow(inch / pts[0][0], 2);
    else if (inch >= pts[pts.length - 1][0]) kg = pts[pts.length - 1][1] * Math.pow(inch / pts[pts.length - 1][0], 2);
    else for (let i = 1; i < pts.length; i++) if (inch <= pts[i][0]) { const a = pts[i - 1], b = pts[i]; kg = a[1] + (b[1] - a[1]) * (inch - a[0]) / (b[0] - a[0]); break; }
    return { kg, basis: 'a ' + (+inch.toFixed(2)) + '" fitting, between the standard sizes' };
  }
  function partWeight(rates, family, size, thickness) {
    const ratio = rates.density[family] / rates.density.Aluminum;
    const range = Object.keys(rates.rangeWeightKg).sort((a, b) => b.length - a.length).find((k) => new RegExp('^' + k + '\\b', 'i').test(size));
    if (range) {
      const t = parseFloat(thickness), f = t > 0 ? clamp(t / rates.thicknessRefMm, 0.5, 2.5) : 1;
      return { kg: rates.rangeWeightKg[range] * ratio * f,
        basis: range.toLowerCase() + ' size' + (f !== 1 ? ', wall ' + t + ' mm (x' + r2(f) + ')' : '') + ', ' + family.toLowerCase() };
    }
    const n = toMm(size);
    if (!n.length || n.some((x) => !(x > 0))) return null;
    let vol;                                                   // mm3
    if (/^[Øø⌀]/.test(String(size).trim())) vol = Math.PI / 4 * n[0] * n[0] * (n[0] / 2);
    else if (n.length >= 3) vol = n[0] * n[1] * n[2];
    else if (n.length === 2) vol = n[0] * n[1] * Math.max(parseFloat(thickness) || Math.min(n[0], n[1]) / 4, 1);
    else vol = Math.pow(n[0], 3) / 4;
    return { kg: vol * rates.fillFactor * rates.density[family] / 1e6, basis: size + ' x ' + Math.round(rates.fillFactor * 100) + '% fill x ' + rates.density[family] + ' g/cm3' };
  }
  const qtyOf = (q) => { const m = /(\d+(?:\.\d+)?)/.exec(String(q || '')); return m ? Number(m[1]) : 0; };

  // returns { ok, ... } or { ok: false, missing: [...] } when the request does not say enough yet
  async function estimate(input, db) {
    const R = await rules(db), rates = R.rates;
    const specs = input.specs || {};
    const itemType = str(input.itemType || specs.itemType), qty = Number(input.quantity) > 0 ? Number(input.quantity) : qtyOf(input.quantity);
    const productSku = str(input.productSku).toUpperCase();
    const markup = R.quoteMarkupPct;
    if (productSku) {                                          // a catalog finished good: its own (automatic) selling price
      const p = (await (db || pool).query(`SELECT sku, name, unit, unit_cost, selling_price, department FROM products WHERE sku = $1 AND NOT is_archived`, [productSku])).rows[0];
      if (p && p.department === FG && +p.selling_price > 0) {
        const per = r2(+p.selling_price);
        return { ok: true, catalog: true, product: p.name, quantity: qty, unit: p.unit, pricePerPiece: per, costPerPiece: r2(+p.unit_cost),
          markupPct: R.fgMarkupPct, total: r2(per * qty), lines: [{ label: p.name + ' catalog price (unit cost + ' + R.fgMarkupPct + '%)', amount: per }], notes: [] };
      }
    }
    const missing = [];
    if (!ITEM_FAMILY[itemType]) missing.push('item type');
    const size = str(specs.size || input.size);
    if (!size) missing.push('size');
    if (!(qty > 0)) missing.push('quantity');
    if (missing.length) return { ok: false, missing };
    const family = ITEM_FAMILY[itemType], notes = [];
    let material = str(specs.material || input.material);
    if (!rates.materialSku[material]) { material = FAMILY_DEFAULT[family]; notes.push('Material not chosen yet: priced as ' + material + '.'); }
    const w = itemType === 'Fitting / valve' ? pipeWeight(rates, size) : partWeight(rates, family, size, specs.thickness || input.thickness);
    if (!w || !(w.kg > 0)) return { ok: false, missing: ['a size the calculator can read'] };
    const kg = w.kg, prices = await materialPrices(db, rates), perKg = prices[material].perKg;
    const finish = str(specs.finish || input.finish), service = str(specs.service || input.service);
    const matCost = kg * (1 + rates.scrapPct / 100) * perKg;
    const process = Math.max(kg * (+rates.processPerKg[itemType] || 0), +rates.processMinPerPc || 0);
    const finRate = +rates.finishPerKg[finish] || 0, fin = finRate > 0 ? Math.max(kg * finRate, +rates.finishMinPerPc || 0) : 0;
    const svc = +rates.servicePerPc[service] || 0;
    const tooling = +rates.toolingPerOrder[itemType] || 0, toolingPc = qty > 0 ? tooling / qty : 0;
    if (finish && rates.finishPerKg[finish] == null) notes.push('No rate for the finish "' + finish + '" yet: not included.');
    if (service && rates.servicePerPc[service] == null) notes.push('No rate for the service "' + service + '" yet: not included.');
    const cost = matCost + process + fin + svc + toolingPc;
    const pricePc = Math.ceil(cost * (1 + markup / 100));
    const lines = [
      { label: 'Material: ' + r3(kg) + ' kg ' + material + ' + ' + rates.scrapPct + '% scrap x ₱' + r2(perKg) + '/kg', amount: r2(matCost) },
      { label: 'Process (' + itemType.toLowerCase() + '): ₱' + rates.processPerKg[itemType] + '/kg, min ₱' + rates.processMinPerPc, amount: r2(process) }
    ];
    if (fin > 0) lines.push({ label: 'Finish: ' + finish + ' (₱' + finRate + '/kg)', amount: r2(fin) });
    if (svc > 0) lines.push({ label: 'Service: ' + service, amount: r2(svc) });
    if (toolingPc > 0) lines.push({ label: 'Tooling / mould ₱' + tooling.toLocaleString('en-PH') + ' shared by ' + qty + ' pcs', amount: r2(toolingPc) });
    return { ok: true, catalog: false, itemType, material, materialPriceFrom: prices[material].from, weightKg: r3(kg), weightBasis: w.basis,
      quantity: qty, lines, costPerPiece: r2(cost), markupPct: markup, pricePerPiece: pricePc, total: r2(pricePc * qty), costTotal: r2(cost * qty), notes };
  }

  /* ---------- routes ---------- */
  app.get('/api/pricing', auth('finance', 'cashier'), wrap(async (req, res) => {
    const R = await rules();
    res.json(Object.assign(R, { materialPrices: await materialPrices(pool, R.rates), defaults: DEFAULT_RATES }));
  }));

  // a live estimate for the request form (customer, cashier, Finance): nothing is saved
  app.post('/api/pricing/quote-estimate', auth('finance', 'cashier', 'customer'), wrap(async (req, res) => {
    res.json(await estimate(req.body || {}));
  }));
  // the system price of a saved request (what the cashier and Finance see next to the price form)
  app.get('/api/pricing/quote/:no', auth('finance', 'cashier'), wrap(async (req, res) => {
    const q = (await pool.query('SELECT quote_no, product_sku, quantity, specs FROM quote_requests WHERE quote_no = $1', [str(req.params.no)])).rows[0];
    if (!q) throw new ValidationError({ id: 'Quotation not found' });
    res.json(await estimate({ specs: q.specs || {}, quantity: q.quantity, productSku: q.product_sku }));
  }));

  const num = (e, key, v, label, max) => {
    const n = Number(v);
    if (v === '' || v == null || !Number.isFinite(n)) { e[key] = label + ' must be a number'; return null; }
    if (n < 0) { e[key] = label + ' cannot be negative'; return null; }
    if (n > max) { e[key] = label + ' is too large'; return null; }
    return Math.round(n * 10000) / 10000;
  };
  app.put('/api/finance/pricing', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {}, e = {};
    const fg = num(e, 'fgMarkupPct', b.fgMarkupPct, 'Finished goods markup', 500);
    const qm = num(e, 'quoteMarkupPct', b.quoteMarkupPct, 'Quote markup', 500);
    const cur = (await rules()).rates, rates = {};
    const inRates = b.rates && typeof b.rates === 'object' ? b.rates : {};
    Object.keys(DEFAULT_RATES).forEach((k) => {
      const d = DEFAULT_RATES[k];
      if (k === 'materialSku') { rates[k] = cur[k]; return; }               // which stock item prices a material: fixed here
      if (d && typeof d === 'object') {
        rates[k] = {};
        Object.keys(d).forEach((sub) => {
          const v = inRates[k] && inRates[k][sub] !== undefined ? inRates[k][sub] : cur[k][sub];
          const n = num(e, 'rates.' + k + '.' + sub, v, sub, 1e7);
          rates[k][sub] = n == null ? cur[k][sub] : n;
        });
      } else {
        const v = inRates[k] !== undefined ? inRates[k] : cur[k];
        const n = num(e, 'rates.' + k, v, k, k === 'fillFactor' ? 1 : k === 'scrapPct' ? 100 : 1e7);
        rates[k] = n == null ? cur[k] : n;
      }
    });
    if (rates.fillFactor <= 0) e['rates.fillFactor'] = 'Fill factor must be more than 0';
    if (rates.thicknessRefMm <= 0) e['rates.thicknessRefMm'] = 'Reference wall must be more than 0';
    if (Object.keys(e).length) throw new ValidationError(e);
    const changed = await tx(async (client) => {
      const before = await rules(client);
      await client.query('UPDATE pricing_rules SET fg_markup_pct = $1, quote_markup_pct = $2, rates = $3, updated_by = $4, updated_at = now() WHERE id = 1',
        [fg, qm, JSON.stringify(rates), req.user.id]);
      // finished goods on automatic pricing follow the new markup straight away
      const n = (await client.query(`UPDATE products SET unit_cost = unit_cost WHERE department = 'Finished Goods' AND price_auto AND NOT is_archived`)).rowCount;
      await audit(client, req.user, 'Record edited', `Pricing rules: finished goods markup ${before.fgMarkupPct}% to ${fg}%, quote markup ${before.quoteMarkupPct}% to ${qm}%` +
        (n ? `; ${n} finished good price${n === 1 ? '' : 's'} recalculated` : ''));
      return n;
    });
    res.json(Object.assign(await rules(), { repriced: changed }));
  }));

  return { estimate, rules, ready };
};
