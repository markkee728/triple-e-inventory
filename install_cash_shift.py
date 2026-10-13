# Run from repository root: python install_cash_shift.py. Creates .cashshift.bak backups.
from pathlib import Path
import shutil,sys
root=Path.cwd(); ui=root/'Finance_Inventory/POS_Cashier.html'; server=root/'backend/server.js'; pos=root/'backend/pos-shop.js'
for f in (ui,server,pos):
 if not f.exists(): sys.exit('Missing '+str(f)+' — run from repository root.')
def patch(file,old,new):
 s=file.read_text(encoding='utf-8')
 if new in s: print('Already installed:',file);return
 if old not in s: sys.exit('Could not find expected insertion point in '+str(file)+'; no change to this file.')
 shutil.copy2(file,str(file)+'.cashshift.bak');file.write_text(s.replace(old,new,1),encoding='utf-8');print('Updated',file)
base=Path(__file__).parent
for source,dest in [('cash-shifts.js',root/'backend/cash-shifts.js'),('cash-shift-ui.js',root/'Finance_Inventory/cash-shift-ui.js'),('cash_shift.sql',root/'backend/db/003_cash_shift.sql'),('Finance_Cash_Shifts.html',root/'Finance_Inventory/Finance_Cash_Shifts.html')]:
 dest.parent.mkdir(parents=True,exist_ok=True)
 if dest.exists() and dest.read_bytes()!= (base/source).read_bytes():sys.exit('File already exists with different content: '+str(dest))
 shutil.copy2(base/source,dest)
patch(server,"require('./pos-shop')({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ, validateShipTo, formatShipTo });","require('./pos-shop')({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ, validateShipTo, formatShipTo });\nrequire('./cash-shifts')({ app, pool, auth, wrap, tx });")
# Transactional shift assignment: serialize checkout with shift close/open via per-cashier advisory lock.
patch(pos,"    const sale = await tx(async (client) => {\n      const items = await loadSellable", "    const sale = await tx(async (client) => {\n      await client.query('SELECT pg_advisory_xact_lock($1,$2)', [73001, req.user.id]);\n      const shiftResult = await client.query('SELECT shift_id FROM pos_cash_shifts WHERE cashier_id=$1 AND closed_at IS NULL FOR UPDATE', [req.user.id]);\n      if (!shiftResult.rowCount) throw bad('cashShift', 'Open your Cash Shift before completing a sale.');\n      const cashShiftId = shiftResult.rows[0].shift_id;\n      const items = await loadSellable")
patch(pos,"INSERT INTO pos_sales (cashier_id, cashier_name, method, total, vat, tendered, change_given, card_ref)\n         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *", "INSERT INTO pos_sales (cashier_id, cashier_name, method, total, vat, tendered, change_given, card_ref, cash_shift_id)\n         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *")
patch(pos,"[req.user.id, req.user.name, method, total, vat, tendered, change, cardRef]);", "[req.user.id, req.user.name, method, total, vat, tendered, change, cardRef, cashShiftId]);")
nav="""      <button class="nav-item" data-page="shift"><svg class="nav-ico" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="15" rx="2"/><path d="M3 10h18M7 6V4h10v2M16 15h3"/></svg>Cash Shift</button>"""
patch(ui,'    </div>\n  </nav>',nav+'\n      </div>\n    </nav>')
section="""    <section class="page" id="page-shift">
      <div class="welcome"><h1>Cash Shift</h1><p>Manual cash reconciliation — no electronic cash drawer required.</p></div>
      <div class="panel" style="padding:24px;max-width:860px">
        <h2 id="shiftStatus">Loading shift...</h2>
        <p id="shiftCheckoutWarning" class="faint">Open a shift before recording sales.</p>
        <div id="shiftOpenPanel" hidden><label for="shiftOpeningInput">Opening cash (₱)</label><input type="number" id="shiftOpeningInput" min="0" max="10000000" step="0.01" placeholder="0.00"><p><button class="btn-primary" id="shiftOpenBtn">Open Cash Shift</button></p></div>
        <div id="shiftClosePanel" hidden>
          <div class="stats" style="margin:18px 0"><div class="stat-card"><div class="stat-label">Opening Cash</div><div class="stat-value" id="shiftOpening">₱0.00</div></div><div class="stat-card"><div class="stat-label">Cash Sales</div><div class="stat-value" id="shiftSales">₱0.00</div></div><div class="stat-card"><div class="stat-label">Expected Cash</div><div class="stat-value" id="shiftExpected">₱0.00</div></div><div class="stat-card"><div class="stat-label">Cash Transactions</div><div class="stat-value" id="shiftTransactions">0</div></div></div>
          <label for="shiftClosingInput">Actual cash counted (₱)</label><input type="number" id="shiftClosingInput" min="0" max="10000000" step="0.01" placeholder="0.00">
          <label for="shiftNote">Closing note (optional)</label><textarea id="shiftNote" rows="2" maxlength="500" placeholder="Explain any shortage or overage"></textarea><p><button class="btn-primary" id="shiftCloseBtn">Close Cash Shift</button></p>
        </div>
      </div>
      <div class="panel" style="margin-top:20px;padding:20px"><h2>My Shift History</h2><div class="table-wrapper"><table><thead><tr><th>Shift</th><th>Opened</th><th>Closed</th><th>Cash Sales</th><th>Difference</th></tr></thead><tbody id="shiftHistory"></tbody></table></div></div>
    </section>
"""
patch(ui,'  </div>\n</main>',section+'  </div>\n</main>')
patch(ui,"const PAGE_TITLES = { terminal: 'Point of Sale', sales: \"Today's Sales\" };", "const PAGE_TITLES = { terminal: 'Point of Sale', sales: \"Today's Sales\", shift: 'Cash Shift' };")
patch(ui,"  busy = false; sales.unshift(sale); resetSale();", "  busy = false; if (window.refreshCashShift) window.refreshCashShift(); sales.unshift(sale); resetSale();")
patch(ui,'</body>','<script src="cash-shift-ui.js?v=1"></script>\n</body>')
print('Files installed. NEXT: run backend/db/003_cash_shift.sql on your PostgreSQL database BEFORE deploying.')
