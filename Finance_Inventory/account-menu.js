/* account-menu.js — the "My Profile / Change Password" window behind the top-bar user menu.
   SHARED by POS_Cashier.html and Shop_Customer.html (same look and behaviour as the Finance Admin menu).

   Load it near the end of <body>, BEFORE the page's own script:
       <script>window.ACCOUNT_CFG = { roleLabel: 'Cashier', idLabel: 'Employee ID', idPrefix: 'TEM', deptLabel: 'Department' };</script>
       <script src="account-menu.js"></script>
   Then, once the signed-in user is known, the page calls:  AccountMenu.setUser(USER);

   Uses the backend routes:  GET/PUT /api/auth/profile · GET/PUT/DELETE /api/auth/avatar
                             GET /api/auth/check-email · PUT /api/auth/password
   The page must have the menu markup: #userMenuWrap, #userChipBtn, #userDropdown with
   #myProfileBtn and #changePasswordBtn buttons inside it. */
(function () {
  'use strict';

  var CFG = Object.assign({ roleLabel: 'User', idLabel: 'Employee ID', idPrefix: 'TEM', deptLabel: 'Department', customer: false }, window.ACCOUNT_CFG || {});
  var CUST = !!CFG.customer;             // customers also edit name parts, birthdate, gender, company info and delivery addresses
  var $ = function (id) { return document.getElementById(id); };
  var EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var NAME_RE = /^[\p{L}][\p{L}\p{M}\s.'’-]*$/u;
  var PHONE_MSG = 'Enter a valid Philippine phone number, e.g. +63 917 123 4567 or 0917 123 4567';
  var MAX_PHOTO = 2 * 1024 * 1024;

  var user = null;                       // { name, email, role, roleLabel } from /api/auth/me
  var saved = null;                      // what the database holds for the profile
  var avatar = { has: false, v: 0 };
  var savedVals = '';
  var saving = false, loadError = '', touched = {}, emailInfo = null, emailTimer = null;

  var clean = function (v) { return String(v == null ? '' : v).trim().replace(/\s+/g, ' '); };
  var initialsOf = function (name) {
    return clean(name).split(' ').filter(Boolean).slice(0, 2).map(function (w) { return w[0].toUpperCase(); }).join('') || CFG.roleLabel.charAt(0);
  };

  /* ---------------- little helpers ---------------- */
  function toast(message, isError) {
    var el = document.createElement('div');
    el.className = 'acct-toast' + (isError ? ' error' : '');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 3500);
  }

  async function api(path, options) {
    var res = await fetch('/api' + path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, options));
    if (res.status === 401) { window.location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { fields: data.fields, status: res.status });
    return data;
  }

  function setError(id, message) {
    var el = $(id);
    if (!el) return;
    el.classList.add('field-invalid');
    var grp = el.closest('.acct-group');
    grp.querySelectorAll('.acct-msg[data-for="' + id + '"]').forEach(function (n) { n.remove(); });
    var m = document.createElement('div');
    m.className = 'acct-msg';
    m.dataset.for = id;
    m.textContent = message;
    grp.appendChild(m);
  }
  function clearError(id) {
    var el = $(id);
    if (!el) return;
    el.classList.remove('field-invalid');
    el.closest('.acct-group').querySelectorAll('.acct-msg[data-for="' + id + '"]').forEach(function (n) { n.remove(); });
  }

  var field = function (id, label, extra, req) {
    return '<div class="acct-group"><label class="acct-label" for="' + id + '">' + label + (req ? ' <span class="acct-req" aria-hidden="true">*</span>' : ' <span class="acct-hint" style="display:inline">(optional)</span>') + '</label>' + extra + '</div>';
  };
  var inp = function (id, attrs) { return '<input type="text" class="acct-input" id="' + id + '" autocomplete="off" ' + (attrs || '') + '>'; };
  function custFields() {
    return '<div class="acct-row">' +
        field('acctFirst', 'First Name', inp('acctFirst', 'maxlength="50"'), true) +
        field('acctLast', 'Last Name', inp('acctLast', 'maxlength="50"'), true) + '</div>' +
      '<div class="acct-row">' +
        field('acctMiddle', 'Middle Name', inp('acctMiddle', 'maxlength="50"')) +
        field('acctSuffix', 'Suffix', '<select class="acct-input" id="acctSuffix"><option value="">None</option><option>Jr.</option><option>Sr.</option><option>II</option><option>III</option><option>IV</option><option>V</option></select>') + '</div>' +
      '<div class="acct-row">' +
        field('acctBirth', 'Birthdate', '<input type="date" class="acct-input" id="acctBirth" min="1900-01-01">') +
        field('acctGender', 'Gender', '<select class="acct-input" id="acctGender"><option value="">Select…</option><option>Male</option><option>Female</option><option>Other</option><option>Prefer Not to Say</option></select>') + '</div>' +
      '<div class="acct-row">' +
        field('acctEmail', 'Email', '<input type="email" class="acct-input" id="acctEmail" maxlength="254" autocomplete="off"><div class="acct-hint" id="acctEmailNote"></div>', true) +
        field('acctPhone', 'Mobile Number', '<input type="tel" class="acct-input" id="acctPhone" maxlength="20" placeholder="0917 123 4567" autocomplete="off">', true) + '</div>' +
      '<div class="acct-row">' +
        field('acctEmpId', CFG.idLabel, '<input type="text" class="acct-input" id="acctEmpId" readonly autocomplete="off">', true).replace(/ <span class="acct-req"[^>]*>\*<\/span>/, '') + '<div></div></div>';
  }
  function companyFields() {
    return '<div class="acct-divider"></div>' +
      '<div class="acct-label" style="margin-bottom:10px">Company information <span class="acct-hint" style="display:inline">(optional — for business customers)</span></div>' +
      '<div class="acct-row">' +
        field('acctCompany', 'Company Name', inp('acctCompany', 'maxlength="120"')) +
        field('acctPosition', 'Your Position', inp('acctPosition', 'maxlength="80"')) + '</div>' +
      '<div class="acct-row">' +
        field('acctTin', 'Company TIN', inp('acctTin', 'maxlength="20" placeholder="123-456-789-000"')) + '<div></div></div>';
  }

  /* ---------------- build the window ---------------- */
  function buildModal() {
    var wrap = document.createElement('div');
    wrap.className = 'acct-overlay';
    wrap.id = 'acctOverlay';
    wrap.innerHTML =
      '<div class="acct-modal" role="dialog" aria-modal="true" aria-labelledby="acctTitle">' +
        '<button type="button" class="acct-close" id="acctClose" aria-label="Close">&times;</button>' +
        '<div class="acct-eyebrow">Account · ' + CFG.roleLabel + '</div>' +
        '<h2 class="acct-title" id="acctTitle">My Account</h2>' +
        '<div class="acct-tabs">' +
          '<button type="button" class="acct-tab active" data-tab="profile">My Profile</button>' +
          (CUST ? '<button type="button" class="acct-tab" data-tab="addresses">Delivery Addresses</button>' : '') +
          '<button type="button" class="acct-tab" data-tab="password">Change Password</button>' +
        '</div>' +

        /* ---- MY PROFILE ---- */
        '<div class="acct-panel active" id="acctProfilePanel">' +
          '<div class="acct-photo-row">' +
            '<div class="avatar acct-avatar" id="acctAvatar">' + initialsOf('') + '</div>' +
            '<div class="acct-photo-actions">' +
              '<button type="button" class="btn-secondary btn-sm" id="acctUpload">Upload photo</button>' +
              '<button type="button" class="btn-secondary btn-sm" id="acctRemove">Remove</button>' +
            '</div>' +
            '<div class="acct-hint">JPG or PNG, up to 2MB</div>' +
          '</div>' +
          '<div class="acct-divider"></div>' +
          (CUST ? custFields() : (
          '<div class="acct-row">' +
            '<div class="acct-group"><label class="acct-label" for="acctName">Full Name <span class="acct-req" aria-hidden="true">*</span></label>' +
              '<input type="text" class="acct-input" id="acctName" maxlength="100" autocomplete="off"></div>' +
            '<div class="acct-group"><label class="acct-label" for="acctEmpId">' + CFG.idLabel + '</label>' +
              '<input type="text" class="acct-input" id="acctEmpId" readonly autocomplete="off"></div>' +
          '</div>' +
          '<div class="acct-row">' +
            '<div class="acct-group"><label class="acct-label" for="acctEmail">Email <span class="acct-req" aria-hidden="true">*</span></label>' +
              '<input type="email" class="acct-input" id="acctEmail" maxlength="254" autocomplete="off"></div>' +
            '<div class="acct-group"><label class="acct-label" for="acctPhone">Phone <span class="acct-req" aria-hidden="true">*</span></label>' +
              '<input type="tel" class="acct-input" id="acctPhone" maxlength="30" placeholder="+63 917 123 4567" autocomplete="off"></div>' +
          '</div>'
          )) +
          '<div class="acct-row">' +
            '<div class="acct-group"><label class="acct-label" for="acctDept">' + CFG.deptLabel + '</label>' +
              '<input type="text" class="acct-input" id="acctDept" readonly autocomplete="off"></div>' +
            '<div class="acct-group"><label class="acct-label" for="acctJoined">Date Joined</label>' +
              '<input type="text" class="acct-input" id="acctJoined" readonly autocomplete="off"></div>' +
          '</div>' +
          '<div class="acct-group"><label class="acct-label">Role</label>' +
            '<div class="acct-role-row"><span class="badge" id="acctRoleBadge">' + CFG.roleLabel + '</span>' +
            (CUST ? '' : '<span class="acct-role-note">Assigned by system — contact your Admin to change roles</span>') + '</div></div>' +
          (CUST ? companyFields() : '') +
          '<div class="acct-banner" id="acctProfileBanner">Please fix the highlighted fields.</div>' +
          '<div class="acct-footer">' +
            '<button type="button" class="btn-secondary" id="acctProfileCancel">Cancel</button>' +
            '<button type="button" class="btn-primary" id="acctProfileSave">Save Changes</button>' +
          '</div>' +
        '</div>' +

        /* ---- DELIVERY ADDRESSES (customers) ---- */
        (CUST ? '<div class="acct-panel" id="acctAddressPanel">' +
          '<div class="acct-hint" style="margin-bottom:12px">Saved addresses are offered at checkout. You can keep up to 5.</div>' +
          '<div id="acctAddrBox"></div>' +
        '</div>' : '') +

        /* ---- CHANGE PASSWORD ---- */
        '<div class="acct-panel" id="acctPasswordPanel">' +
          '<div class="acct-group"><label class="acct-label" for="acctCurPw">Current Password</label>' +
            '<input type="password" class="acct-input" id="acctCurPw" placeholder="Enter current password" autocomplete="current-password"></div>' +
          '<div class="acct-group"><label class="acct-label" for="acctNewPw">New Password</label>' +
            '<input type="password" class="acct-input" id="acctNewPw" placeholder="Enter new password" autocomplete="new-password">' +
            '<div class="acct-strength"><div class="acct-strength-fill" id="acctStrengthFill"></div></div>' +
            '<div class="acct-strength-label" id="acctStrengthLabel">Strength: —</div></div>' +
          '<div class="acct-group"><label class="acct-label" for="acctConfPw">Confirm New Password</label>' +
            '<input type="password" class="acct-input" id="acctConfPw" placeholder="Re-enter new password" autocomplete="new-password"></div>' +
          '<div class="acct-checklist" id="acctChecklist">' +
            '<div class="acct-check" data-rule="length"><span class="acct-dot"></span>At least 8 characters</div>' +
            '<div class="acct-check" data-rule="upper"><span class="acct-dot"></span>One uppercase letter (A–Z)</div>' +
            '<div class="acct-check" data-rule="lower"><span class="acct-dot"></span>One lowercase letter (a–z)</div>' +
            '<div class="acct-check" data-rule="number"><span class="acct-dot"></span>One number (0–9)</div>' +
            '<div class="acct-check" data-rule="special"><span class="acct-dot"></span>One special character (!@#$%^&amp;* etc.)</div>' +
            '<div class="acct-check" data-rule="match"><span class="acct-dot"></span>Passwords match</div>' +
          '</div>' +
          '<div class="acct-banner" id="acctPasswordBanner">Check the fields above — passwords must match and meet all requirements.</div>' +
          '<div class="acct-footer">' +
            '<button type="button" class="btn-secondary" id="acctPwCancel">Cancel</button>' +
            '<button type="button" class="btn-primary" id="acctPwSave">Update Password</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    var picker = document.createElement('input');
    picker.type = 'file'; picker.accept = 'image/jpeg,image/png'; picker.hidden = true; picker.id = 'acctPicker';
    document.body.appendChild(picker);
  }

  /* ---------------- show user / photo ---------------- */
  function paintUser() {
    if (!user) return;
    var name = user.name || CFG.roleLabel;
    var set = function (sel, v) { document.querySelectorAll(sel).forEach(function (n) { n.textContent = v; }); };
    set('.user-chip .uname', name);
    set('.dropdown-name', name);
    if (user.email) set('.dropdown-email', user.email);
    paintAvatar();
  }

  function paintAvatar() {
    var initials = initialsOf(user && user.name);
    document.querySelectorAll('#acctAvatar, .user-chip .avatar, .dropdown-avatar').forEach(function (n) {
      if (avatar.has) {
        n.style.backgroundImage = 'url("/api/auth/avatar?v=' + avatar.v + '")';
        n.style.backgroundSize = 'cover';
        n.style.backgroundPosition = 'center';
        n.textContent = '';
      } else {
        n.style.backgroundImage = ''; n.style.backgroundSize = ''; n.style.backgroundPosition = '';
        n.textContent = initials;
      }
    });
    var rm = $('acctRemove');
    if (rm) rm.disabled = !avatar.has;
  }

  /* ---------------- open / close ---------------- */
  function switchTab(tab) {
    document.querySelectorAll('.acct-tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    $('acctProfilePanel').classList.toggle('active', tab === 'profile');
    $('acctPasswordPanel').classList.toggle('active', tab === 'password');
    if (CUST) {
      $('acctAddressPanel').classList.toggle('active', tab === 'addresses');
      if (tab === 'addresses' && window.ShopAddress) ShopAddress.openIn('acctAddrBox');
      else if (window.ShopAddress) ShopAddress.closeEmbedded();
    }
  }
  function openModal(tab) {
    $('acctOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
    switchTab(tab || 'profile');
    if (tab !== 'password' && tab !== 'addresses') loadProfile();
    var first = tab === 'password' ? $('acctCurPw') : (CUST ? $('acctFirst') : $('acctName'));
    setTimeout(function () { if (first) first.focus(); }, 30);
  }
  function closeModal() {
    $('acctOverlay').classList.remove('open');
    document.body.style.overflow = '';
    resetPassword();
    if (saved) fill(saved);
    $('acctProfileBanner').classList.remove('show');
    if (CUST && window.ShopAddress) ShopAddress.closeEmbedded();
    window.dispatchEvent(new CustomEvent('accountmenu:close'));          // lets the shop redraw its checkout address box
  }

  /* ---------------- profile form ---------------- */
  var fields = CUST ? ['acctFirst', 'acctMiddle', 'acctLast', 'acctBirth', 'acctEmail', 'acctPhone', 'acctCompany', 'acctPosition', 'acctTin']
                    : ['acctName', 'acctEmail', 'acctPhone'];
  var values = function () {
    if (!CUST) return { name: clean($('acctName').value), email: clean($('acctEmail').value).toLowerCase(), phone: clean($('acctPhone').value) };
    return { firstName: clean($('acctFirst').value), middleName: clean($('acctMiddle').value), lastName: clean($('acctLast').value), suffix: $('acctSuffix').value,
      birthdate: $('acctBirth').value, gender: $('acctGender').value, email: clean($('acctEmail').value).toLowerCase(), phone: clean($('acctPhone').value),
      companyName: clean($('acctCompany').value), companyPosition: clean($('acctPosition').value), companyTin: clean($('acctTin').value) };
  };
  function mobileProblem(raw) {
    if (/[^\d+\s().-]/.test(raw)) return 'Mobile number can only have digits, +, spaces and dashes';
    var p = raw.replace(/[\s().-]/g, '');
    if (p.indexOf('+63') === 0) p = p.slice(3); else if (p.indexOf('63') === 0) p = p.slice(2); else if (p.indexOf('09') === 0) p = p.slice(1);
    else if (p[0] !== '9') return 'Enter a valid Philippine mobile number, e.g. 0917 123 4567';
    return /^9\d{9}$/.test(p) ? '' : 'Enter a valid Philippine mobile number, e.g. 0917 123 4567 or +63 917 123 4567';
  }
  function custProblems(v) {
    var e = {};
    var nm = function (id, val, label, req) {
      if (!val) { if (req) e[id] = label + ' is required'; return; }
      if (req && val.length < 2) e[id] = label + ' must be at least 2 characters';
      else if (val.length > 50) e[id] = label + ' must be at most 50 characters';
      else if (!NAME_RE.test(val)) e[id] = "Letters, spaces, . ' and - only";
    };
    nm('acctFirst', v.firstName, 'First name', true); nm('acctLast', v.lastName, 'Last name', true); nm('acctMiddle', v.middleName, 'Middle name', false);
    if (v.birthdate) {
      var today = new Date(), iso = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
      if (v.birthdate > iso) e.acctBirth = 'Birthdate cannot be in the future'; else if (v.birthdate < '1900-01-01') e.acctBirth = 'Enter a valid birthdate';
    }
    if (v.companyTin && !/^\d{3}-?\d{3}-?\d{3}(-?\d{3,5})?$/.test(v.companyTin)) e.acctTin = 'TIN must be 9 or 12 digits, e.g. 123-456-789-000';
    if (v.companyName && v.companyName.length < 2) e.acctCompany = 'Company name must be at least 2 characters';
    return e;
  }

  function phoneError(raw) {
    if (/[^\d+\s().-]/.test(raw)) return 'Phone number can only have digits, +, spaces and dashes';
    var p = raw.replace(/[\s().-]/g, '');
    if (p.indexOf('+63') === 0) {
      var r = p.slice(3);
      if (!/^\d+$/.test(r)) return PHONE_MSG;
      if (r[0] === '9') return r.length === 10 ? '' : 'A +63 mobile number needs 10 digits after +63, e.g. +63 917 123 4567';
      return r.length >= 9 && r.length <= 10 ? '' : PHONE_MSG;
    }
    if (p.indexOf('09') === 0) return /^09\d{9}$/.test(p) ? '' : 'A 09 mobile number needs 11 digits, e.g. 0917 123 4567';
    return PHONE_MSG;
  }

  function problems(v) {
    var e = CUST ? custProblems(v) : {};
    if (!CUST && !v.name) e.acctName = 'Full name is required';
    else if (!CUST && v.name.length < 2) e.acctName = 'Full name must be at least 2 characters';
    else if (!CUST && v.name.length > 100) e.acctName = 'Full name must be at most 100 characters';
    else if (!CUST && !NAME_RE.test(v.name)) e.acctName = "Full name can only have letters, spaces, . ' and -";
    if (!v.email) e.acctEmail = 'Email is required';
    else if (v.email.length > 254 || !EMAIL_FORMAT.test(v.email)) e.acctEmail = 'Enter a valid email address';
    else if (emailInfo && emailInfo.email === v.email && emailInfo.taken) e.acctEmail = 'That email is already used by another account';
    else if (emailInfo && emailInfo.email === v.email && emailInfo.domainMsg) e.acctEmail = emailInfo.domainMsg;
    if (!v.phone) e.acctPhone = CUST ? 'Mobile number is required' : 'Phone number is required';
    else if (CUST) { var mm = mobileProblem(v.phone); if (mm) e.acctPhone = mm; }
    else if (v.phone.length < 7) e.acctPhone = 'Phone number must be at least 7 characters';
    else { var m = phoneError(v.phone); if (m) e.acctPhone = m; }
    return e;
  }

  function paintForm(onlyTouched) {
    var e = problems(values());
    fields.forEach(function (id) {
      clearError(id);
      if (e[id] && (!onlyTouched || touched[id])) setError(id, e[id]);
    });
    if (!Object.keys(e).length && !loadError) $('acctProfileBanner').classList.remove('show');
    return e;
  }

  function emailStatus(text, ok) {
    var grp = $('acctEmail').closest('.acct-group');
    var n = grp.querySelector('.acct-email-status');
    if (!text) { if (n) n.remove(); return; }
    if (!n) { n = document.createElement('div'); n.className = 'acct-hint acct-email-status'; grp.appendChild(n); }
    n.textContent = text;
    n.classList.toggle('tick', !!ok);
    n.style.color = ok ? 'var(--green)' : '';
  }

  function checkEmailSoon() {
    clearTimeout(emailTimer);
    var v = values();
    if (!v.email || !EMAIL_FORMAT.test(v.email) || (saved && v.email === saved.email.toLowerCase())) { emailInfo = null; emailStatus(''); return; }
    emailStatus('Checking email domain…');
    emailTimer = setTimeout(async function () {
      try {
        var r = await api('/auth/check-email?email=' + encodeURIComponent(v.email));
        if (values().email !== v.email) return;
        emailInfo = { email: v.email, taken: !!r.taken, domainMsg: r.domainOk === false ? (r.message || 'That email domain cannot receive email') : '', unverified: !!r.unverified };
        paintForm(true);
        if (emailInfo.taken || emailInfo.domainMsg) emailStatus('');
        else if (emailInfo.unverified) emailStatus('Email format is OK (domain could not be checked right now)');
        else emailStatus('Email domain is valid', true);
      } catch (err) { /* the server checks again on save */ }
    }, 600);
  }

  function fill(p) {
    saved = p;
    if (CUST) {
      $('acctFirst').value = p.firstName || ''; $('acctMiddle').value = p.middleName || ''; $('acctLast').value = p.lastName || '';
      $('acctSuffix').value = p.suffix || ''; $('acctBirth').value = p.birthdate || ''; $('acctGender').value = p.gender || '';
      $('acctCompany').value = p.companyName || ''; $('acctPosition').value = p.companyPosition || ''; $('acctTin').value = p.companyTin || '';
      $('acctBirth').max = new Date().toISOString().slice(0, 10);
      var note = $('acctEmailNote');
      note.textContent = p.pendingEmail ? 'Waiting for you to confirm ' + p.pendingEmail + ' — check that inbox. Your current email still works.'
        : (p.emailVerified ? 'Verified' : 'Not verified yet');
      note.classList.toggle('tick', !p.pendingEmail && !!p.emailVerified);
      note.style.color = !p.pendingEmail && p.emailVerified ? 'var(--green)' : '';
    } else $('acctName').value = p.name || '';
    $('acctEmail').value = p.email || '';
    $('acctPhone').value = p.phone || '';
    var digits = String(p.employeeId || '').replace(/\D/g, '');
    $('acctEmpId').value = digits ? CFG.idPrefix + '-' + digits : '';
    $('acctDept').value = p.department || p.roleLabel || '';
    $('acctJoined').value = p.joined || '';
    var badge = $('acctRoleBadge'); if (badge) badge.textContent = p.roleLabel || CFG.roleLabel;
    avatar = { has: !!p.hasAvatar, v: avatar.v || Date.now() };
    fields.forEach(function (id) { touched[id] = false; });
    emailInfo = null; emailStatus('');
    savedVals = JSON.stringify(values());
    paintAvatar();
    paintForm(true);
  }

  async function loadProfile() {
    var banner = $('acctProfileBanner');
    try {
      var p = await api('/auth/profile');
      loadError = '';
      banner.classList.remove('show');
      fill(p);
      user = Object.assign({}, user, { name: p.name, email: p.email });
      paintUser();
    } catch (err) {
      if (err.message === 'Not signed in') return;
      loadError = 'Could not load your profile (' + err.message + '). Click Save Changes to try again.';
      banner.textContent = loadError;
      banner.classList.add('show');
    }
  }

  async function saveProfile() {
    if (saving) return;
    var banner = $('acctProfileBanner');
    if (!saved) { await loadProfile(); return; }
    fields.forEach(function (id) { touched[id] = true; });
    var e = paintForm(false);
    if (Object.keys(e).length) {
      banner.textContent = 'Please fix the highlighted fields.';
      banner.classList.add('show');
      var first = fields.filter(function (id) { return e[id]; })[0];
      if (first) $(first).focus();
      return;
    }
    var v = values();
    if (JSON.stringify(v) === savedVals) { toast('No changes to save'); return; }
    var btn = $('acctProfileSave'), label = btn.textContent;
    saving = true; btn.disabled = true; btn.textContent = 'Saving…';
    try {
      var p = await api('/auth/profile', { method: 'PUT', body: JSON.stringify(v) });
      fill(p);
      user = Object.assign({}, user, { name: p.name, email: p.email });
      paintUser();
      toast(p.message || 'Profile saved', !!p.message && /could not/i.test(p.message));
      closeModal();
    } catch (err) {
      if (err.message === 'Not signed in') return;
      var map = { name: 'acctName', email: 'acctEmail', phone: 'acctPhone', firstName: 'acctFirst', middleName: 'acctMiddle', lastName: 'acctLast',
        birthdate: 'acctBirth', companyName: 'acctCompany', companyPosition: 'acctPosition', companyTin: 'acctTin' };
      var any = false;
      Object.keys(err.fields || {}).forEach(function (k) { if (map[k] && $(map[k])) { setError(map[k], err.fields[k]); any = true; } });
      banner.textContent = any ? 'Please fix the highlighted fields.' : err.message;
      banner.classList.add('show');
    } finally {
      saving = false; btn.disabled = false; btn.textContent = label;
    }
  }

  /* ---------------- photo ---------------- */
  function photoMsg(text) {
    var row = $('acctUpload').closest('.acct-photo-row');
    row.querySelectorAll('.acct-photo-msg').forEach(function (n) { n.remove(); });
    if (!text) return;
    var m = document.createElement('div');
    m.className = 'acct-msg acct-photo-msg';
    m.textContent = text;
    row.appendChild(m);
  }

  async function uploadPhoto(f) {
    if (!f) return;
    if (!/^image\/(jpeg|png)$/.test(f.type)) return photoMsg('Choose a JPG or PNG image');
    if (!f.size) return photoMsg('That file is empty');
    if (f.size > MAX_PHOTO) return photoMsg('Photo must be 2 MB or smaller (yours is ' + (f.size / 1048576).toFixed(1) + ' MB)');
    var btn = $('acctUpload'), label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Uploading…';
    try {
      var res = await fetch('/api/auth/avatar', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': f.type }, body: f });
      if (res.status === 401) { window.location.href = 'Login_Inventory.html'; return; }
      var j = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error((j.fields && j.fields.photo) || j.error || 'Upload failed');
      avatar = { has: true, v: Date.now() };
      paintAvatar();
      toast('Photo updated');
    } catch (err) { photoMsg(err.message); }
    finally { btn.disabled = false; btn.textContent = label; }
  }

  async function removePhoto() {
    photoMsg('');
    if (!avatar.has) return photoMsg('You have no photo to remove');
    $('acctRemove').disabled = true;
    try { await api('/auth/avatar', { method: 'DELETE' }); avatar = { has: false, v: 0 }; toast('Photo removed'); }
    catch (err) { if (err.message !== 'Not signed in') photoMsg(err.message); }
    paintAvatar();
  }

  /* ---------------- change password ---------------- */
  function pwRules(pw, conf) {
    return {
      length: pw.length >= 8,
      upper: /[A-Z]/.test(pw),
      lower: /[a-z]/.test(pw),
      number: /[0-9]/.test(pw),
      special: /[!@#$%^&*()_\-+=\[\]{};:'",.<>\/?\\|`~]/.test(pw),
      match: pw.length > 0 && pw === conf
    };
  }

  function paintPassword() {
    var pw = $('acctNewPw').value, conf = $('acctConfPw').value;
    var rules = pwRules(pw, conf);
    document.querySelectorAll('#acctChecklist .acct-check').forEach(function (it) { it.classList.toggle('met', !!rules[it.dataset.rule]); });
    var count = ['length', 'upper', 'lower', 'number', 'special'].filter(function (r) { return rules[r]; }).length;
    var pct = 0, label = '—', color = 'var(--red)';
    if (pw.length) {
      pct = count / 5 * 100;
      if (count <= 2) { label = 'Weak'; color = 'var(--red)'; }
      else if (count === 3) { label = 'Fair'; color = 'var(--amber)'; }
      else if (count === 4) { label = 'Good'; color = 'var(--blue-bright)'; }
      else { label = 'Strong'; color = 'var(--green)'; }
    }
    $('acctStrengthFill').style.width = pct + '%';
    $('acctStrengthFill').style.background = color;
    $('acctStrengthLabel').textContent = 'Strength: ' + label;
    return rules;
  }

  function resetPassword() {
    ['acctCurPw', 'acctNewPw', 'acctConfPw'].forEach(function (id) { $(id).value = ''; clearError(id); });
    $('acctPasswordBanner').classList.remove('show');
    paintPassword();
  }

  async function savePassword() {
    var banner = $('acctPasswordBanner');
    var cur = $('acctCurPw').value, pw = $('acctNewPw').value, conf = $('acctConfPw').value;
    var rules = pwRules(pw, conf);
    ['acctCurPw', 'acctNewPw', 'acctConfPw'].forEach(clearError);
    if (!cur.trim() || !Object.keys(rules).every(function (k) { return rules[k]; })) {
      banner.textContent = 'Check the fields above — passwords must match and meet all requirements.';
      banner.classList.add('show');
      if (!cur.trim()) setError('acctCurPw', 'Current password is required');
      return;
    }
    banner.classList.remove('show');
    var btn = $('acctPwSave'), label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Updating…';
    try {
      await api('/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword: cur, newPassword: pw }) });
      toast('Password updated');
      closeModal();
    } catch (err) {
      if (err.message === 'Not signed in') return;
      var f = err.fields || {};
      if (f.currentPassword) setError('acctCurPw', f.currentPassword);
      if (f.newPassword) setError('acctNewPw', f.newPassword);
      banner.textContent = (f.currentPassword || f.newPassword) ? 'Please fix the highlighted fields.' : (err.status === 404 ? 'The backend is running an old server.js: replace it and restart.' : err.message);
      banner.classList.add('show');
    } finally { btn.disabled = false; btn.textContent = label; }
  }

  /* ---------------- wire everything up ---------------- */
  function init() {
    buildModal();
    var dropdown = $('userDropdown');
    var hideMenu = function () { if (dropdown) dropdown.classList.remove('open'); var c = $('userChipBtn'); if (c) c.setAttribute('aria-expanded', 'false'); };

    var pBtn = $('myProfileBtn'), cBtn = $('changePasswordBtn');
    if (pBtn) pBtn.addEventListener('click', function () { hideMenu(); openModal('profile'); });
    if (cBtn) cBtn.addEventListener('click', function () { hideMenu(); openModal('password'); });

    $('acctClose').addEventListener('click', closeModal);
    $('acctProfileCancel').addEventListener('click', closeModal);
    $('acctPwCancel').addEventListener('click', closeModal);
    $('acctOverlay').addEventListener('mousedown', function (e) { if (e.target === $('acctOverlay')) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('acctOverlay').classList.contains('open')) closeModal(); });
    document.querySelectorAll('.acct-tab').forEach(function (b) { b.addEventListener('click', function () { switchTab(b.dataset.tab); }); });

    $('acctPhone').addEventListener('input', function () {
      var next = this.value.replace(/[^\d+\s().-]/g, '');
      if (next !== this.value) this.value = next;
    });
    fields.forEach(function (id) {
      $(id).addEventListener('input', function () { touched[id] = true; if (id === 'acctEmail') checkEmailSoon(); paintForm(true); });
      $(id).addEventListener('blur', function () { touched[id] = true; paintForm(true); });
    });
    if (!CUST) $('acctName').addEventListener('blur', function () { this.value = clean(this.value); });
    if (CUST) ['acctSuffix', 'acctGender'].forEach(function (id) { $(id).addEventListener('change', function () { paintForm(true); }); });
    $('acctEmail').addEventListener('blur', function () { this.value = clean(this.value).toLowerCase(); });
    $('acctProfileSave').addEventListener('click', saveProfile);

    $('acctUpload').addEventListener('click', function () { photoMsg(''); $('acctPicker').value = ''; $('acctPicker').click(); });
    $('acctPicker').addEventListener('change', function () { uploadPhoto(this.files && this.files[0]); });
    $('acctRemove').addEventListener('click', removePhoto);

    ['acctNewPw', 'acctConfPw'].forEach(function (id) { $(id).addEventListener('input', paintPassword); });
    $('acctPwSave').addEventListener('click', savePassword);
    paintPassword();
    paintAvatar();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  /* ---------------- public API ---------------- */
  window.AccountMenu = {
    // call once the signed-in user is known (the object returned by /api/auth/me)
    setUser: function (u) {
      user = u || null;
      paintUser();
      // fetch the photo flag + phone etc. in the background so the chip shows the real picture
      api('/auth/profile').then(function (p) { avatar = { has: !!p.hasAvatar, v: Date.now() }; user = Object.assign({}, user, { name: p.name, email: p.email }); paintUser(); }).catch(function () {});
    },
    open: openModal
  };
})();
