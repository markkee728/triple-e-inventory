/* quick-stock.js — shortcut: double-click a product row in Inventory Monitoring to record Stock In / Stock Out.

   Window 1: choose Stock In or Stock Out, quantity, reason (and supplier / invoice for a supplier delivery, note when the reason needs one).
   Window 2: "Are you sure you want to proceed?" with a recap. Only "Yes, save" writes the movement (POST /api/movements),
   the same call the Stock In / Out page makes, so the server checks, the reference number and the audit log are identical.
   The reason list and supplier list follow the product (department / linked suppliers) exactly like the full form. */
(function () {
  'use strict';
  const B = () => window.TripleEBridge;
  const $ = (id) => document.getElementById(id);
  let item = null, type = 'in', step = 'form', busy = false, overlay = null;

  const num = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });
  const esc = (v) => B().esc(v);

  function build() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'quickStockOverlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = '<div class="account-modal qs-modal" id="qsModal"></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && !busy) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('open') && !busy) close(); });
  }
  function close() { if (overlay) overlay.classList.remove('open'); item = null; step = 'form'; }

  const reasons = () => B().reasonsFor(type, item.department).filter((r) => r.key !== 'produced_batch');   // produced batches deduct materials: done on the Stock In / Out page

  function renderForm(keep) {
    keep = keep || {};
    const rs = reasons();
    const modal = $('qsModal');
    modal.innerHTML =
      '<button type="button" class="modal-close" id="qsClose" aria-label="Close">×</button>' +
      '<div class="qs-head"><div class="modal-eyebrow">Quick stock entry</div><h2>' + esc(item.name) + '</h2>' +
      '<div class="qs-meta"><span>' + esc(item.sku) + '</span><span>' + esc(item.department) + '</span><span>On hand: <b>' + num(item.onHand) + ' ' + esc(item.unit) + '</b></span></div></div>' +
      '<div class="segmented" id="qsType"><button type="button" class="seg-btn seg-in' + (type === 'in' ? ' active' : '') + '" data-type="in">Stock In</button>' +
      '<button type="button" class="seg-btn seg-out' + (type === 'out' ? ' active' : '') + '" data-type="out">Stock Out</button></div>' +
      '<form id="qsForm" novalidate autocomplete="off">' +
      '<div class="qs-row"><div class="form-group"><label class="form-label" for="qsQty">Quantity <span class="required-mark">*</span></label>' +
      '<input type="number" inputmode="decimal" id="qsQty" class="form-input" min="0" step="any" placeholder="e.g. 500" value="' + esc(keep.qty || '') + '"></div>' +
      '<div class="form-group"><label class="form-label" for="qsUnit">Unit</label><input type="text" id="qsUnit" class="form-input" readonly tabindex="-1" value="' + esc(item.unit) + '"></div></div>' +
      '<div class="form-group"><label class="form-label" for="qsReason">Reason <span class="required-mark">*</span></label>' +
      '<select id="qsReason" class="form-select"><option value="">' + (type === 'out' ? 'Why is this stock going out?' : 'Why is this stock coming in?') + '</option>' +
      rs.map((r) => '<option value="' + esc(r.key) + '"' + (keep.reason === r.key ? ' selected' : '') + '>' + esc(r.label) + '</option>').join('') + '</select>' +
      '<div class="field-hint" id="qsReasonHint"></div></div>' +
      '<div id="qsReceipt" hidden><div class="form-group"><label class="form-label" for="qsSupplier">Supplier <span class="required-mark">*</span></label>' +
      '<select id="qsSupplier" class="form-select"></select><div class="field-hint" id="qsSupplierHint"></div></div>' +
      '<div class="form-group"><label class="form-label" for="qsInvoice">Invoice / delivery no.</label>' +
      '<input type="text" id="qsInvoice" class="form-input" maxlength="40" placeholder="Supplier\u2019s document no." value="' + esc(keep.invoice || '') + '"></div></div>' +
      '<div class="form-group" id="qsNoteWrap" hidden><label class="form-label" for="qsNote">Note <span class="required-mark">*</span></label>' +
      '<textarea id="qsNote" class="form-textarea" rows="2" maxlength="300" placeholder="Explain what happened (required)…">' + esc(keep.note || '') + '</textarea></div>' +
      '<div class="qs-summary"><span>After this entry</span><b id="qsAfter">—</b></div>' +
      '<p class="qs-error" id="qsError" role="alert"></p>' +
      '<div class="modal-footer"><button type="button" class="btn-secondary" id="qsCancel">Cancel</button>' +
      '<button type="submit" class="btn-primary" id="qsNext">Continue</button></div></form>';
    $('qsClose').onclick = $('qsCancel').onclick = () => close();
    $('qsType').onclick = (e) => {
      const b = e.target.closest('.seg-btn'); if (!b || b.dataset.type === type) return;
      type = b.dataset.type; renderForm({ qty: $('qsQty').value, note: $('qsNote').value });   // reasons differ for in / out
    };
    $('qsReason').onchange = sync; $('qsQty').oninput = sync; $('qsSupplier').onchange = clearErr;
    $('qsInvoice').oninput = clearErr; $('qsNote').oninput = clearErr;
    $('qsForm').onsubmit = (e) => { e.preventDefault(); toConfirm(); };
    sync();
    if (keep.supplier && $('qsSupplier').querySelector('option[value="' + keep.supplier + '"]')) $('qsSupplier').value = keep.supplier;
    setTimeout(() => $('qsQty').focus(), 30);
  }

  const clearErr = () => { const e = $('qsError'); if (e) e.textContent = ''; };

  // show / hide the supplier + note boxes for the chosen reason and update the "after" figure
  function sync() {
    clearErr();
    const reason = $('qsReason').value, qty = Number($('qsQty').value) || 0;
    const isReceipt = type === 'in' && reason === 'supplier_receipt';
    $('qsReceipt').hidden = !isReceipt;
    if (isReceipt) {
      const sel = $('qsSupplier'), m = B().suppliersFor(item), prev = sel.value;
      sel.innerHTML = '<option value="">' + (m.anyActive ? 'Select the supplier…' : 'No active suppliers yet') + '</option>' +
        m.list.map((s) => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>').join('');
      if (prev && m.list.some((s) => s.id === prev)) sel.value = prev; else if (m.linkedOnly && m.list.length === 1) sel.value = m.list[0].id;
      $('qsSupplierHint').textContent = m.linkedOnly ? 'Showing only suppliers that supply this product.' : 'No supplier is linked to this product yet — showing all active suppliers.';
    }
    $('qsNoteWrap').hidden = !B().noteRequired(reason);
    const r = reasons().find((x) => x.key === reason);
    $('qsReasonHint').textContent = r ? r.help : (item.department === 'Finished Goods' && type === 'in' ? 'Produced batches are recorded on the Stock In / Out page (Produced Internally).' : '');
    const after = item.onHand + (type === 'in' ? qty : -qty), a = $('qsAfter');
    a.textContent = qty ? num(Math.max(after, 0)) + ' ' + item.unit + (after < 0 ? ' (not enough stock)' : '') : '—';
    a.className = after < 0 ? 'bad' : '';
  }

  function read() {
    const reason = $('qsReason').value, qty = Number($('qsQty').value);
    const isReceipt = type === 'in' && reason === 'supplier_receipt';
    const supSel = $('qsSupplier');
    return { qty, reason, reasonLabel: ($('qsReason').selectedOptions[0] || {}).text || '', note: $('qsNote').value.trim().replace(/\s+/g, ' '),
      supplier: isReceipt ? supSel.value : '', supplierName: isReceipt && supSel.selectedOptions[0] ? supSel.selectedOptions[0].text : '',
      invoice: isReceipt ? $('qsInvoice').value.trim() : '' };
  }
  function problem(v) {
    if (!$('qsQty').value || !isFinite(v.qty) || v.qty <= 0) return ['qsQty', 'Enter a quantity greater than zero.'];
    if (type === 'out' && v.qty > item.onHand) return ['qsQty', 'Only ' + num(item.onHand) + ' ' + item.unit + ' on hand — cannot take out ' + num(v.qty) + '.'];
    if (!v.reason) return ['qsReason', type === 'out' ? 'Choose why this stock is going out.' : 'Choose why this stock is coming in.'];
    if (type === 'in' && v.reason === 'supplier_receipt' && !v.supplier) return ['qsSupplier', 'Choose the supplier this delivery came from.'];
    if (B().noteRequired(v.reason) && v.note.length < 3) return ['qsNote', 'Please explain this entry in the note.'];
    return null;
  }

  // window 2: "are you sure?"
  function toConfirm() {
    const v = read(), p = problem(v);
    if (p) { $('qsError').textContent = p[1]; $(p[0]).focus(); return; }
    step = 'confirm';
    const after = item.onHand + (type === 'in' ? v.qty : -v.qty);
    const line = (k, val, cls) => '<div><span>' + k + '</span><b' + (cls ? ' class="' + cls + '"' : '') + '>' + val + '</b></div>';
    $('qsModal').innerHTML =
      '<button type="button" class="modal-close" id="qsClose" aria-label="Close">×</button>' +
      '<div class="qs-confirm"><div class="qs-confirm-ico" aria-hidden="true">?</div><h3>Do you want to proceed?</h3>' +
      '<p>This ' + (type === 'in' ? 'adds to' : 'removes from') + ' your stock and cannot be edited afterwards. Please check the details.</p>' +
      '<div class="qs-recap">' + line('Product', esc(item.name)) + line('Movement', type === 'in' ? 'Stock In' : 'Stock Out', type) +
      line('Quantity', num(v.qty) + ' ' + esc(item.unit)) + line('Reason', esc(v.reasonLabel)) +
      (v.supplierName ? line('Supplier', esc(v.supplierName)) : '') + (v.invoice ? line('Invoice / delivery no.', esc(v.invoice)) : '') +
      (v.note ? line('Note', esc(v.note)) : '') +
      line('Stock after', num(Math.max(after, 0)) + ' ' + esc(item.unit)) + '</div>' +
      '<p class="qs-error" id="qsError" role="alert"></p></div>' +
      '<div class="modal-footer"><button type="button" class="btn-secondary" id="qsBack">Go back</button>' +
      '<button type="button" class="btn-primary" id="qsConfirm">Yes, save it</button></div>';
    $('qsClose').onclick = () => { if (!busy) close(); };
    $('qsBack').onclick = () => { step = 'form'; renderForm({ qty: String(v.qty), reason: v.reason, note: v.note, invoice: v.invoice, supplier: v.supplier }); };
    $('qsConfirm').onclick = () => save(v);
    $('qsConfirm').focus();
  }

  async function save(v) {
    if (busy) return;
    busy = true; const btn = $('qsConfirm'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await B().api('/movements', { method: 'POST', body: JSON.stringify({ sku: item.sku, type, reason: v.reason, quantity: v.qty, note: v.note,
        supplier: v.supplier || undefined, invoiceNo: v.invoice || undefined }) });
      busy = false; close(); B().toast('Saved. Reference no. ' + r.ref); await B().reload();
    } catch (err) {
      busy = false; btn.disabled = false; btn.textContent = 'Yes, save it';
      const f = err.fields && Object.values(err.fields)[0];
      $('qsError').textContent = f || err.message || 'Could not save. Please try again.';
    }
  }

  function open(sku) {
    const found = B() && B().inventory().find((i) => i.sku === sku);
    if (!found) return;
    build(); item = found; type = 'in'; step = 'form';
    renderForm();
    overlay.classList.add('open');
  }

  document.addEventListener('dblclick', (e) => {
    const row = e.target.closest && e.target.closest('#stockLevelsTableBody tr[data-sku]');
    if (!row) return;
    const sel = window.getSelection && window.getSelection(); if (sel) sel.removeAllRanges();      // double-click also selects a word: clear it
    open(row.dataset.sku);
  });
})();
