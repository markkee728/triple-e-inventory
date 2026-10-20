/* Cashier customer directory + product review moderation.
   Click anywhere on a customer row to open the customer's details (same layout Finance uses). Click a review row to see
   the review together with who wrote it. Passwords, hashes and verification tokens are never sent to this screen. */
(function () {
'use strict';
const el = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shown = v => (v == null || String(v).trim() === '' ? 'Not provided' : esc(v));
const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('') || '?';
const isActive = v => String(v || '').toLowerCase() === 'active';
const stars = n => '<span class="cm-stars" aria-label="' + n + ' out of 5">' + '\u2605'.repeat(n) + '<i>' + '\u2605'.repeat(5 - n) + '</i></span>';
const day = ms => (ms ? new Date(ms).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' }) : '');

let people = [], reviewList = [], lastFocus = null, token = 0;

async function request(url, opts) {
  const r = await fetch(url, { credentials: 'include', ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(j.error || 'Request failed (' + r.status + ')');
  return j;
}

/* ---------- styles (the cashier page does not load the Finance customer styles) ---------- */
function addStyles() {
  if (el('cmStyles')) return;
  const s = document.createElement('style'); s.id = 'cmStyles';
  s.textContent = `
.cm-row{cursor:pointer;transition:background .15s}.cm-row:hover{background:var(--hover)}.cm-row:focus-visible{outline:2px solid var(--blue-bright);outline-offset:-2px}
.cm-pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:600;border:1px solid var(--border)}
.cm-pill.on{color:var(--green);border-color:var(--green)}.cm-pill.off{color:var(--red);border-color:var(--red)}
.cm-stars{color:var(--amber);letter-spacing:1px;white-space:nowrap}.cm-stars i{font-style:normal;color:var(--border)}
#cmModal{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px}
#cmModal[hidden]{display:none}
#cmModal .cm-back{position:absolute;inset:0;background:rgba(3,10,16,.66)}
#cmModal .cm-card{position:relative;width:min(640px,100%);max-height:calc(100vh - 32px);overflow:auto;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow)}
#cmModal .cm-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--panel);z-index:1}
#cmModal .cm-head h2{margin:0;font-size:18px}
#cmModal .cm-x{border:0;background:transparent;color:var(--text);font-size:26px;line-height:1;cursor:pointer;padding:2px 8px;border-radius:6px}
#cmModal .cm-x:hover{background:var(--hover)}
#cmModal .cm-body{padding:18px 20px 22px}
#cmModal .cm-top{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:6px}
#cmModal .cm-av{width:48px;height:48px;border-radius:50%;background:var(--inset);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-weight:700;flex:none}
#cmModal .cm-top strong{display:block;font-size:16px}#cmModal .cm-top span.dim{font-size:13.5px;overflow-wrap:anywhere}
#cmModal .cm-tabs{display:flex;gap:6px;margin:14px 0 4px;border-bottom:1px solid var(--border)}
#cmModal .cm-tab{border:0;background:transparent;color:var(--text-dim);padding:8px 12px;cursor:pointer;font:inherit;border-bottom:2px solid transparent;margin-bottom:-1px}
#cmModal .cm-tab.active{color:var(--text);border-bottom-color:var(--blue-bright);font-weight:600}
#cmModal h3{margin:20px 0 8px;font-size:12px;letter-spacing:1.2px;text-transform:uppercase;color:var(--text-faint)}
#cmModal .cm-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 18px}
@media(max-width:520px){#cmModal .cm-grid{grid-template-columns:1fr}}
#cmModal .cm-f span{display:block;font-size:11.5px;color:var(--text-faint);margin-bottom:1px}
#cmModal .cm-f strong{font-weight:500;overflow-wrap:anywhere}#cmModal .cm-f.is-empty strong{color:var(--text-faint);font-weight:400}
#cmModal .cm-rev{padding:12px 14px;border:1px solid var(--border);border-radius:10px;margin-top:10px;background:var(--card)}
#cmModal .cm-rev header{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
#cmModal .cm-rev p{margin:8px 0 0;white-space:pre-line;overflow-wrap:anywhere;line-height:1.5}
#cmModal .cm-rev small,#cmModal .cm-note{color:var(--text-dim);font-size:12.5px}
#cmModal .cm-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
#cmModal .cm-err{color:var(--red);font-size:13px;min-height:18px;margin-top:6px}
#cmModal input.cm-reason{display:block;width:100%;margin-top:6px}
.cm-danger{background:transparent;color:var(--red);border:1px solid var(--red);border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit}`;
  document.head.appendChild(s);
}
function ensureModal() {
  addStyles();
  if (el('cmModal')) return;
  const m = document.createElement('div'); m.id = 'cmModal'; m.hidden = true;
  m.innerHTML = '<div class="cm-back" data-cm-close></div><div class="cm-card" role="dialog" aria-modal="true" aria-labelledby="cmTitle" tabindex="-1">' +
    '<div class="cm-head"><h2 id="cmTitle"></h2><button type="button" class="cm-x" data-cm-close aria-label="Close">\u00D7</button></div><div class="cm-body" id="cmBody"></div></div>';
  document.body.appendChild(m);
  m.addEventListener('click', e => { if (e.target.closest('[data-cm-close]')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !m.hidden) closeModal(); });
}
function openModal(title) { ensureModal(); lastFocus = document.activeElement; el('cmTitle').textContent = title; el('cmModal').hidden = false; el('cmModal').querySelector('.cm-x').focus(); }
function closeModal() { token++; const m = el('cmModal'); if (m) m.hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
const field = (l, v) => '<div class="cm-f' + (v == null || String(v).trim() === '' ? ' is-empty' : '') + '"><span>' + esc(l) + '</span><strong>' + shown(v) + '</strong></div>';
const section = (t, items) => '<h3>' + esc(t) + '</h3><div class="cm-grid">' + items.map(i => field(i[0], i[1])).join('') + '</div>';
const loadReviewList = () => request('/api/finance/reviews');

/* ---------- customers ---------- */
function renderPeople() {
  const q = (el('cmSearch').value || '').toLowerCase().trim();
  const list = people.filter(u => (u.name + ' ' + u.email).toLowerCase().includes(q));
  el('cmRows').innerHTML = list.map(u => '<tr class="cm-row" tabindex="0" role="button" aria-label="View details for ' + esc(u.name) + '" data-profile="' + Number(u.id) + '">' +
    '<td>' + esc(u.name) + '</td><td>' + esc(u.email) + '</td><td>' + esc(u.phone || '\u2014') + '</td>' +
    '<td><span class="cm-pill ' + (isActive(u.status) ? 'on' : 'off') + '">' + (isActive(u.status) ? 'Active' : 'Disabled') + '</span></td>' +
    '<td><button type="button" class="btn-secondary btn-sm" data-profile="' + Number(u.id) + '">View</button></td></tr>').join('') || '<tr><td colspan="5">No matching customers.</td></tr>';
}
async function loadPeople() {
  el('cmMessage').textContent = 'Loading\u2026';
  try { people = await request('/api/pos/customer-directory'); renderPeople(); el('cmMessage').textContent = people.length + ' registered customers'; }
  catch (e) { el('cmMessage').textContent = e.message; }
}
function reviewsHtml(list) {
  if (!list.length) return '<p class="cm-note" style="margin-top:14px">This customer has not reviewed any product yet.</p>';
  const avg = (list.reduce((t, r) => t + r.rating, 0) / list.length).toFixed(1);
  return '<p class="cm-note" style="margin:14px 0 0">' + list.length + ' review' + (list.length === 1 ? '' : 's') + ' \u00B7 average ' + avg + '/5 \u00B7 ' + list.filter(r => r.status === 'hidden').length + ' hidden</p>' +
    list.map(r => '<article class="cm-rev"><header><div><strong>' + esc(r.product) + '</strong><br><small>' + esc(r.sku) + (r.orderNo ? ' \u00B7 Order ' + esc(r.orderNo) : '') + '</small></div>' + stars(r.rating) + '</header><p>' +
      (r.body ? esc(r.body) : '<em>No comment</em>') + '</p><small>' + esc(day(r.createdAt)) + ' \u00B7 ' + (r.status === 'hidden' ? 'Hidden' : 'Visible') + '</small></article>').join('');
}
async function openProfile(id) {
  const base = people.find(x => String(x.id) === String(id)) || {};
  const tok = ++token; openModal(base.name || 'Customer details');
  el('cmBody').innerHTML = '<p class="cm-note">Loading profile\u2026</p>';
  try {
    const d = await request('/api/pos/customers/' + encodeURIComponent(id) + '/profile'); if (tok !== token) return;
    el('cmTitle').textContent = d.name || 'Customer details';
    el('cmBody').innerHTML = '<div class="cm-top"><span class="cm-av" aria-hidden="true">' + esc(initials(d.name)) + '</span><div><strong>' + shown(d.name) + '</strong><span class="dim">' + shown(d.email) + '</span></div>' +
      '<span class="cm-pill ' + (isActive(d.status) ? 'on' : 'off') + '" style="margin-left:auto">' + (isActive(d.status) ? 'Active' : 'Disabled') + '</span></div>' +
      '<div class="cm-tabs" role="tablist"><button type="button" role="tab" class="cm-tab active" data-cm-tab="profile">Profile</button><button type="button" role="tab" class="cm-tab" data-cm-tab="reviews">Reviews <b id="cmRevCount">\u2026</b></button></div>' +
      '<div data-cm-pane="profile">' +
        section('Personal information', [['First name', d.firstName], ['Middle name', d.middleName], ['Last name', d.lastName], ['Suffix', d.suffix], ['Birthdate', d.birthdate], ['Gender', d.gender]]) +
        section('Contact & account', [['Email', d.email], ['Phone', d.phone], ['Username', d.username], ['Email verified', d.emailVerified ? 'Yes' : 'No'], ['Joined', d.joined], ['Last login', d.lastLogin]]) +
        section('Company', [['Company', d.companyName], ['Position', d.companyPosition]]) + '</div>' +
      '<div data-cm-pane="reviews" hidden><p class="cm-note">Loading reviews\u2026</p></div>';
    loadReviewList().then(all => { if (tok !== token) return; const mine = all.filter(r => String(r.userId) === String(id)); el('cmRevCount').textContent = mine.length; el('cmBody').querySelector('[data-cm-pane="reviews"]').innerHTML = reviewsHtml(mine); })
      .catch(e => { if (tok === token) el('cmBody').querySelector('[data-cm-pane="reviews"]').innerHTML = '<p class="cm-err">' + esc(e.message) + '</p>'; });
  } catch (e) { if (tok === token) el('cmBody').innerHTML = '<p class="cm-err">' + esc(e.message) + '</p>'; }
}

/* ---------- product reviews ---------- */
function renderReviews() {
  el('cmReviewMessage').textContent = reviewList.length + ' review' + (reviewList.length === 1 ? '' : 's') + ' \u00B7 ' + reviewList.filter(r => r.status === 'hidden').length + ' hidden';
  el('cmReviews').innerHTML = reviewList.length ? '<div style="overflow-x:auto"><table style="width:100%"><thead><tr><th>Product</th><th>Rating</th><th>Customer</th><th>Date</th><th>Status</th></tr></thead><tbody>' +
    reviewList.map(r => '<tr class="cm-row" tabindex="0" role="button" aria-label="View review and customer details for ' + esc(r.customer) + '" data-review-row="' + Number(r.id) + '">' +
      '<td>' + esc(r.product) + '<div class="faint" style="font-size:12px">' + esc(r.sku) + '</div></td><td>' + stars(r.rating) + '</td><td>' + esc(r.customer) + '</td><td>' + esc(day(r.createdAt)) + '</td>' +
      '<td><span class="cm-pill ' + (r.status === 'hidden' ? 'off' : 'on') + '">' + (r.status === 'hidden' ? 'Hidden' : 'Visible') + '</span></td></tr>').join('') + '</tbody></table></div>' : 'No reviews found.';
}
async function loadReviews() {
  el('cmReviewMessage').textContent = 'Loading\u2026';
  try { reviewList = await loadReviewList(); renderReviews(); } catch (e) { el('cmReviewMessage').textContent = e.message; }
}
async function setVisibility(rv, hide, reason, errBox, btn) {
  try { if (btn) btn.disabled = true;
    await request('/api/finance/reviews/' + rv.id + '/visibility', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hidden: hide, reason: reason || '' }) });
    closeModal(); await loadReviews();
  } catch (e) { if (errBox) errBox.textContent = e.message; if (btn) btn.disabled = false; }
}
async function openReview(id) {
  const rv = reviewList.find(x => x.id === Number(id)); if (!rv) return;
  const tok = ++token; openModal('Review details');
  function paint(d, note) {
    if (tok !== token) return; d = d || {};
    el('cmBody').innerHTML = '<div class="cm-rev" style="margin-top:0"><header><strong>' + esc(rv.product) + '</strong>' + stars(rv.rating) + '</header>' +
      '<small>' + esc(rv.sku) + (rv.orderNo ? ' \u00B7 Order ' + esc(rv.orderNo) : '') + ' \u00B7 ' + esc(day(rv.createdAt)) + ' \u00B7 ' + (rv.status === 'hidden' ? 'Hidden' : 'Visible') + '</small>' +
      '<p>' + (rv.body ? esc(rv.body) : '<em>No comment</em>') + '</p>' +
      (rv.status === 'hidden' && rv.hiddenReason ? '<small>Hidden: ' + esc(rv.hiddenReason) + (rv.hiddenBy ? ' (' + esc(rv.hiddenBy) + ')' : '') + '</small>' : '') + '</div>' +
      '<h3>Customer</h3><div class="cm-top"><span class="cm-av" aria-hidden="true">' + esc(initials(d.name || rv.customer)) + '</span><div><strong>' + shown(d.name || rv.customer) + '</strong><span class="dim">' + shown(d.email || rv.email) + '</span></div></div>' +
      (note ? '<p class="cm-note">' + esc(note) + '</p>' : '<div class="cm-grid" style="margin-top:10px">' + field('Phone', d.phone) + field('Birthdate', d.birthdate) + field('Gender', d.gender) + field('Email verified', d.emailVerified ? 'Yes' : 'No') + field('Joined', d.joined) + field('Last login', d.lastLogin) + field('Company', d.companyName) + field('Position', d.companyPosition) + '</div>') +
      '<div id="cmHideBox"></div><div class="cm-actions"><button type="button" class="' + (rv.status === 'hidden' ? 'btn-secondary' : 'cm-danger') + '" id="cmAct">' + (rv.status === 'hidden' ? 'Restore review' : 'Hide review') + '</button><button type="button" class="btn-secondary" data-cm-close>Close</button></div>';
    el('cmAct').onclick = () => {
      if (rv.status === 'hidden') return setVisibility(rv, false, '', el('cmHideBox'), el('cmAct'));
      el('cmHideBox').innerHTML = '<h3>Reason for hiding</h3><input id="cmReason" class="cm-reason" maxlength="300" placeholder="e.g. Abusive language (kept in the audit log)"><div class="cm-err" id="cmErr" role="alert"></div>' +
        '<div class="cm-actions" style="margin-top:8px"><button type="button" class="cm-danger" id="cmHideGo">Confirm hide</button></div>';
      el('cmReason').focus();
      el('cmHideGo').onclick = () => { const r = el('cmReason').value.trim(); if (r.length < 3) { el('cmErr').textContent = 'Enter a reason (at least 3 characters).'; return; } setVisibility(rv, true, r, el('cmErr'), el('cmHideGo')); };
    };
  }
  paint(null, 'Loading customer details\u2026');
  try { if (!rv.userId) throw Error('Customer details unavailable.'); paint(await request('/api/pos/customers/' + encodeURIComponent(rv.userId) + '/profile')); }
  catch (e) { paint(null, e.message); }
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-cm-tab]');
  if (t) { const box = el('cmBody'); box.querySelectorAll('[data-cm-tab]').forEach(x => x.classList.toggle('active', x === t)); box.querySelectorAll('[data-cm-pane]').forEach(p => p.hidden = p.dataset.cmPane !== t.dataset.cmTab); return; }
  const p = e.target.closest('[data-profile]'); if (p) return openProfile(p.dataset.profile);
  const r = e.target.closest('[data-review-row]'); if (r) openReview(r.dataset.reviewRow);
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr.cm-row')) { e.preventDefault(); e.target.click(); }
});
document.addEventListener('DOMContentLoaded', () => {
  el('cmSearch')?.addEventListener('input', renderPeople);
  el('cmRefresh')?.addEventListener('click', loadPeople);
  el('cmReviewRefresh')?.addEventListener('click', loadReviews);
});
window.cashierCustomers = { load: loadPeople, reviews: loadReviews };
})();
