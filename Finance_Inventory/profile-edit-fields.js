/* profile-edit-fields.js — the profile fields Finance edits for ANY account (Customer Management and User Management).
   Same fields and same rules as sign-up / My Profile: first, middle, last name, suffix, email, mobile number, birthdate, gender,
   and (customers only) company name, position and TIN. The server checks everything again (PATCH /api/users/:id).

     ProfileEdit.mount(el, prefix)        build the fields inside el (ids start with prefix)
     ProfileEdit.fill(prefix, profile, isCustomer)   put a profile from GET /api/users/:id/profile into the fields
     ProfileEdit.read(prefix, isCustomer)            -> the body to send
     ProfileEdit.check(prefix, isCustomer)           -> { field: message } the browser can already see (empty = fine)
     ProfileEdit.showErrors(prefix, fields)          red message under each wrong field
     ProfileEdit.setBusy(prefix, busy)               lock the fields while loading / saving */
(function () {
  'use strict';
  var SUFFIXES = ['Jr.', 'Sr.', 'II', 'III', 'IV', 'V'], GENDERS = ['Male', 'Female', 'Other', 'Prefer Not to Say'];
  var NAME_RE = /^\p{L}[\p{L}\p{M} ]*$/u, EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var FIELDS = ['First', 'Middle', 'Last', 'Suffix', 'Email', 'Phone', 'Birthdate', 'Gender', 'CompanyName', 'CompanyPosition', 'CompanyTin'];
  var KEY = { First: 'firstName', Middle: 'middleName', Last: 'lastName', Suffix: 'suffix', Email: 'email', Phone: 'phone', Birthdate: 'birthdate',
              Gender: 'gender', CompanyName: 'companyName', CompanyPosition: 'companyPosition', CompanyTin: 'companyTin' };

  if (!document.getElementById('peStyle')) {
    var st = document.createElement('style'); st.id = 'peStyle';
    st.textContent =
      '.pe-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 14px}.pe-grid .pe-wide{grid-column:1/-1}' +
      '.pe-field{display:flex;flex-direction:column;gap:5px;min-width:0}' +
      '.pe-field>span{font-size:12px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim)}' +
      '.pe-field input,.pe-field select{width:100%;max-width:none;box-sizing:border-box}' +
      '.pe-field input.pe-bad,.pe-field select.pe-bad{border-color:var(--red,#c0392b)}' +
      '.pe-msg{font-size:12.5px;color:var(--red,#c0392b)}' +
      '.pe-title{grid-column:1/-1;margin:6px 0 -2px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim);border-top:1px solid var(--border);padding-top:12px}' +
      '@media(max-width:560px){.pe-grid{grid-template-columns:1fr}}';
    document.head.appendChild(st);
  }
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function field(p, name, label, inner, wide, req) {
    return '<label class="pe-field' + (wide ? ' pe-wide' : '') + '" data-pe="' + p + name + '"><span>' + label + (req ? ' *' : '') + '</span>' + inner + '<div class="pe-msg"></div></label>';
  }
  function input(p, name, attrs) { return '<input class="inv-search form-input" id="' + p + name + '" autocomplete="off" ' + (attrs || '') + '>'; }
  function select(p, name, list, blank) {
    return '<select class="inv-search form-select" id="' + p + name + '"><option value="">' + blank + '</option>' + list.map(function (v) { return '<option>' + esc(v) + '</option>'; }).join('') + '</select>';
  }

  function mount(el, p) {
    el.innerHTML = '<div class="pe-grid">' +
      field(p, 'First', 'First name', input(p, 'First', 'maxlength="50"'), false, true) +
      field(p, 'Middle', 'Middle name', input(p, 'Middle', 'maxlength="50"'), false) +
      field(p, 'Last', 'Last name', input(p, 'Last', 'maxlength="50"'), false, true) +
      field(p, 'Suffix', 'Suffix', select(p, 'Suffix', SUFFIXES, 'None'), false) +
      field(p, 'Email', 'Email', input(p, 'Email', 'type="email" maxlength="254"'), true, true) +
      field(p, 'Phone', 'Mobile number', input(p, 'Phone', 'type="tel" maxlength="20" placeholder="0917 123 4567"'), false) +
      field(p, 'Birthdate', 'Birthdate', input(p, 'Birthdate', 'type="date"'), false) +
      field(p, 'Gender', 'Gender', select(p, 'Gender', GENDERS, 'Not set'), true) +
      '<div class="pe-title" data-pe-company="' + p + '">Company information</div>' +
      field(p, 'CompanyName', 'Company', input(p, 'CompanyName', 'maxlength="120"'), true) +
      field(p, 'CompanyPosition', 'Position', input(p, 'CompanyPosition', 'maxlength="80"'), false) +
      field(p, 'CompanyTin', 'Company TIN', input(p, 'CompanyTin', 'maxlength="20" placeholder="123-456-789-000"'), false) +
      '</div>';
    $(p + 'Phone').addEventListener('input', function () { var n = this.value.replace(/[^\d+\s().-]/g, ''); if (n !== this.value) this.value = n; });
    FIELDS.forEach(function (f) { $(p + f).addEventListener('input', function () { clearOne(p + f); }); $(p + f).addEventListener('change', function () { clearOne(p + f); }); });
  }
  function company(p, on) {
    ['CompanyName', 'CompanyPosition', 'CompanyTin'].forEach(function (f) { document.querySelector('[data-pe="' + p + f + '"]').style.display = on ? '' : 'none'; });
    document.querySelector('[data-pe-company="' + p + '"]').style.display = on ? '' : 'none';
  }
  function clearOne(id) {
    var el = $(id); if (!el) return;
    el.classList.remove('pe-bad');
    var m = el.parentNode.querySelector('.pe-msg'); if (m) m.textContent = '';
  }
  function fill(p, d, isCustomer) {
    company(p, !!isCustomer);
    FIELDS.forEach(function (f) { clearOne(p + f); $(p + f).value = d[KEY[f]] || ''; });
  }
  function read(p, isCustomer) {
    var b = {};
    FIELDS.forEach(function (f) {
      if (!isCustomer && /^Company/.test(f)) return;
      var v = $(p + f).value.trim().replace(/\s+/g, ' ');
      b[KEY[f]] = f === 'Email' ? v.toLowerCase() : v;
    });
    return b;
  }
  function check(p, isCustomer) {
    var b = read(p, isCustomer), e = {};
    [['firstName', 'First name'], ['lastName', 'Last name']].forEach(function (x) {
      if (b[x[0]].length < 2) e[x[0]] = x[1] + ' is required (at least 2 letters)';
    });
    ['firstName', 'middleName', 'lastName'].forEach(function (k) { if (b[k] && !e[k] && !NAME_RE.test(b[k])) e[k] = 'Letters and spaces only'; });
    if (!b.email) e.email = 'Email is required'; else if (!EMAIL_RE.test(b.email)) e.email = 'Enter a valid email address';
    return e;
  }
  function showErrors(p, fields) {
    var first = null;
    Object.keys(fields || {}).forEach(function (k) {
      var f = FIELDS.filter(function (x) { return KEY[x] === k; })[0];
      if (!f) return;
      var el = $(p + f); el.classList.add('pe-bad'); el.parentNode.querySelector('.pe-msg').textContent = fields[k];
      if (!first) first = el;
    });
    if (first) first.focus();
    return !!first;
  }
  function setBusy(p, busy) { FIELDS.forEach(function (f) { $(p + f).disabled = !!busy; }); }

  window.ProfileEdit = { mount: mount, fill: fill, read: read, check: check, showErrors: showErrors, setBusy: setBusy };
})();
