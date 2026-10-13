// Mount from server.js AFTER auth(), wrap(), tx() are defined.
module.exports = function mountCashShifts({app,pool,auth,wrap,tx}) {
 const fail = (res, status, error) => res.status(status).json({error});
 const money = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 10000000 && Math.round(x*100) === x*100;
 const summarySql = `SELECT s.shift_id AS id, s.cashier_id AS "cashierId", s.cashier_name AS "cashierName", s.opened_at AS "openedAt", s.closed_at AS "closedAt", s.opening_cash::float8 AS "openingCash", s.closing_cash::float8 AS "closingCash", s.closing_note AS "closingNote", COALESCE(SUM(p.total) FILTER (WHERE p.status <> 'Voided' AND p.method = 'Cash'),0)::float8 AS "cashSales", COUNT(p.sale_id) FILTER (WHERE p.status <> 'Voided' AND p.method = 'Cash')::int AS "cashTransactions", (s.opening_cash + COALESCE(SUM(p.total) FILTER (WHERE p.status <> 'Voided' AND p.method = 'Cash'),0) + COALESCE((SELECT SUM(CASE WHEN m.kind='cash_in' THEN m.amount ELSE -m.amount END) FROM pos_cash_movements m WHERE m.shift_id=s.shift_id),0))::float8 AS "expectedCash", CASE WHEN s.closed_at IS NOT NULL THEN (s.closing_cash - s.opening_cash - COALESCE(SUM(p.total) FILTER (WHERE p.status <> 'Voided' AND p.method = 'Cash'),0) - COALESCE((SELECT SUM(CASE WHEN m.kind='cash_in' THEN m.amount ELSE -m.amount END) FROM pos_cash_movements m WHERE m.shift_id=s.shift_id),0))::float8 END AS "difference" FROM pos_cash_shifts s LEFT JOIN pos_sales p ON p.cash_shift_id = s.shift_id GROUP BY s.shift_id`;
 app.get('/api/pos/cash-shifts/current',auth('cashier'),wrap(async(req,res)=>{
  const r=await pool.query(`SELECT * FROM (${summarySql}) x WHERE "cashierId"=$1 AND "closedAt" IS NULL LIMIT 1`,[req.user.id]);res.json(r.rows[0]||null);
 }));
 app.post('/api/pos/cash-shifts/open',auth('cashier'),wrap(async(req,res)=>{
  const amount=req.body?.openingCash;
  if(!money(amount))return fail(res,400,'Enter a valid opening cash amount (0 or more, up to 2 decimals).');
  const result=await tx(async client=>{
   await client.query('SELECT pg_advisory_xact_lock($1,$2)',[73001,req.user.id]);
   const old=await client.query('SELECT shift_id FROM pos_cash_shifts WHERE cashier_id=$1 AND closed_at IS NULL',[req.user.id]);
   if(old.rowCount)return {error:'You already have an open cash shift.'};
   const r=await client.query('INSERT INTO pos_cash_shifts(cashier_id,cashier_name,opening_cash) VALUES ($1,$2,$3) RETURNING shift_id',[req.user.id,req.user.name,amount]);return {id:r.rows[0].shift_id};
  });if(result.error)return fail(res,409,result.error);res.status(201).json(result);
 }));
 app.post('/api/pos/cash-shifts/close',auth('cashier'),wrap(async(req,res)=>{
  const amount=req.body?.closingCash, note=req.body?.note;
  if(!money(amount))return fail(res,400,'Enter the actual cash counted (0 or more, up to 2 decimals).');
  if(typeof note!=='string'||note.length>500)return fail(res,400,'Closing note must be at most 500 characters.');
  const result=await tx(async client=>{
   await client.query('SELECT pg_advisory_xact_lock($1,$2)',[73001,req.user.id]);
   const r=await client.query('SELECT shift_id FROM pos_cash_shifts WHERE cashier_id=$1 AND closed_at IS NULL FOR UPDATE',[req.user.id]);
   if(!r.rowCount)return {error:'No open shift found.'};
   await client.query('UPDATE pos_cash_shifts SET closed_at=now(),closing_cash=$2,closing_note=$3 WHERE shift_id=$1',[r.rows[0].shift_id,amount,note.trim()]);
   const report=await client.query(`SELECT * FROM (${summarySql}) x WHERE id=$1`,[r.rows[0].shift_id]);return report.rows[0];
  });if(result.error)return fail(res,409,result.error);res.json(result);
 }));
 app.post('/api/pos/cash-shifts/movements',auth('cashier'),wrap(async(req,res)=>{
  const {kind,amount,reason}=req.body||{};
  if(!['cash_in','cash_out'].includes(kind)||!money(amount)||amount<=0||typeof reason!=='string'||reason.trim().length<5||reason.trim().length>300) return fail(res,400,'Enter a valid type, amount, and reason (5–300 characters).');
  const result=await tx(async client=>{
    await client.query('SELECT pg_advisory_xact_lock($1,$2)',[73001,req.user.id]);
    const shift=await client.query('SELECT shift_id FROM pos_cash_shifts WHERE cashier_id=$1 AND closed_at IS NULL FOR UPDATE',[req.user.id]);
    if(!shift.rowCount)return {error:'Open a cash shift first.'};
    const r=await client.query('INSERT INTO pos_cash_movements(shift_id,cashier_id,kind,amount,reason) VALUES($1,$2,$3,$4,$5) RETURNING movement_id',[shift.rows[0].shift_id,req.user.id,kind,amount,reason.trim()]);
    return {id:r.rows[0].movement_id};
  });
  if(result.error)return fail(res,409,result.error);res.status(201).json(result);
 }));
 app.get('/api/pos/cash-shifts/movements',auth('cashier','finance'),wrap(async(req,res)=>{
  const finance=req.user.role==='finance';
  const r=await pool.query(`SELECT m.movement_id AS id,m.shift_id AS "shiftId",m.kind,m.amount::float8 AS amount,m.reason,m.created_at AS "createdAt",s.cashier_name AS "cashierName" FROM pos_cash_movements m JOIN pos_cash_shifts s ON s.shift_id=m.shift_id ${finance?'':'WHERE m.cashier_id=$1'} ORDER BY m.created_at DESC LIMIT 300`,finance?[]:[req.user.id]);
  res.json(r.rows);
 }));
 app.get('/api/pos/cash-shifts/history',auth('cashier','finance'),wrap(async(req,res)=>{
  const finance=req.user.role==='finance';
  const q=finance?`SELECT * FROM (${summarySql}) x ORDER BY "openedAt" DESC LIMIT 200`:`SELECT * FROM (${summarySql}) x WHERE "cashierId"=$1 ORDER BY "openedAt" DESC LIMIT 50`;
  const r=await pool.query(q,finance?[]:[req.user.id]);res.json(r.rows);
 }));
};
