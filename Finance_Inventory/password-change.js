/* password-change.js — ONE change-password flow shared by every role (Finance Admin, Cashier, Customer).

   The steps, always in this order:
     1) The person TYPES their current password (the system never fills it in). The server checks it; if it is wrong nothing else happens.
     2) The new password must pass the rules and be typed twice.
     3) Only then a code is sent to their EMAIL and another to their MOBILE NUMBER. BOTH codes must be entered.
     4) Update Password saves it (the server checks the current password and both codes again).

   Backend: POST /api/auth/password/check · POST /api/auth/password/otp · PUT /api/auth/password   (backend/password-otp.js, server.js)

   Each page gives it its fields and a few helpers:
     PasswordChange.create({ cur, nw, conf, saveBtn, otpMount, api, rulesMet, setError, clearError, banner, toast, onDone })
   It returns { reset }  — call reset() whenever the password window opens or closes. */
(function () {
  'use strict';

  var CHANNELS = [
    { key: 'email', label: 'Email code', field: 'emailCode', noun: 'email' },
    { key: 'sms', label: 'Mobile number code', field: 'smsCode', noun: 'mobile number' }
  ];

  function create(cfg) {
    var stage = 0, info = null, active = [], timers = {};
    var original = 'Continue';

    /* ---- the code section (built here so every page looks and works the same) ---- */
    var box = cfg.otpMount;
    box.style.display = 'none';
    box.innerHTML =
      '<div class="pc-hint" style="font-size:13px;margin:0 0 10px"></div>' +
      '<div class="pc-rows" style="display:flex;flex-direction:column;gap:12px"></div>' +
      '<button type="button" class="btn-secondary pc-edit" style="margin-top:12px;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px">Edit the passwords</button>';
    var hint = box.querySelector('.pc-hint'), rows = box.querySelector('.pc-rows');

    function say(msg, bad) { hint.textContent = msg; hint.style.color = bad ? 'var(--red, #c0392b)' : ''; }
    function codeInput(ch) { return rows.querySelector('input[data-ch="' + ch + '"]'); }
    function sendBtn(ch) { return rows.querySelector('button[data-ch="' + ch + '"]'); }
    function rowNote(ch, msg, bad) { var n = rows.querySelector('.pc-note[data-ch="' + ch + '"]'); if (n) { n.textContent = msg; n.style.color = bad ? 'var(--red, #c0392b)' : ''; } }

    function lock(on) {
      [cfg.cur, cfg.nw, cfg.conf].forEach(function (el) { el.readOnly = !!on; });
    }
    function cooldown(ch, sec) {
      var b = sendBtn(ch); if (!b) return;
      clearInterval(timers[ch]);
      if (!(sec > 0)) { b.disabled = false; b.textContent = 'Resend code'; return; }
      b.disabled = true; b.textContent = 'Resend in ' + sec + 's';
      timers[ch] = setInterval(function () {
        sec--;
        if (sec <= 0) { clearInterval(timers[ch]); b.disabled = false; b.textContent = 'Resend code'; }
        else b.textContent = 'Resend in ' + sec + 's';
      }, 1000);
    }
    function backToFields() {                       // stage 0: passwords can be edited again, nothing is pending
      stage = 0; info = null; active = [];
      CHANNELS.forEach(function (c) { clearInterval(timers[c.key]); });
      lock(false);
      box.style.display = 'none'; rows.innerHTML = '';
      cfg.saveBtn.textContent = 'Continue'; cfg.saveBtn.disabled = false;
    }

    async function send(ch) {
      var b = sendBtn(ch); if (!b) return;
      b.disabled = true; cfg.clearError(codeInput(ch));
      try {
        var r = await cfg.api('/auth/password/otp', { method: 'POST', body: JSON.stringify({ channel: ch, currentPassword: cfg.cur.value }) });
        var noun = ch === 'sms' ? 'mobile number' : 'email';
        if (r.sent || r.recent) rowNote(ch, r.recent ? r.message : 'Code sent to your ' + noun + '. It expires in ' + Math.round((r.expiresIn || 600) / 60) + ' minutes.');
        else rowNote(ch, r.message || 'The code could not be sent.', true);
        cooldown(ch, r.waitSeconds || 60);
      } catch (err) {
        if (err.message === 'Not signed in') return;
        if (err.fields && err.fields.currentPassword) { backToFields(); cfg.setError(cfg.cur, err.fields.currentPassword); cfg.cur.focus(); return; }
        rowNote(ch, err.message, true); b.disabled = false;
      }
    }

    function showCodeStage(res) {                   // stage 1: the current password was right, now BOTH codes
      info = res; stage = 1; lock(true);
      active = CHANNELS.filter(function (c) { return res[c.key]; });
      rows.innerHTML = '';
      CHANNELS.forEach(function (c) {
        var o = res[c.key];
        var row = document.createElement('div');
        row.innerHTML =
          '<label style="display:block;font-size:13px;font-weight:600;margin:0 0 4px">' + c.label + (o ? ' — ' + o.masked : '') + '</label>' +
          (o
            ? '<div style="display:flex;gap:8px"><input type="text" class="form-input acct-input" data-ch="' + c.key + '" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6-digit code" style="flex:1">' +
              '<button type="button" class="btn-secondary" data-ch="' + c.key + '" style="white-space:nowrap;padding:10px 14px;border-radius:6px;cursor:pointer">Send code</button></div>' +
              '<div class="pc-note" data-ch="' + c.key + '" style="font-size:12.5px;margin-top:5px"></div>'
            : '<div style="font-size:12.5px;opacity:.7">Not available on this account</div>');
        rows.appendChild(row);
      });
      active.forEach(function (c) {
        codeInput(c.key).addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 6); cfg.clearError(this); });
        sendBtn(c.key).addEventListener('click', function () { send(c.key); });
      });
      box.style.display = '';
      cfg.saveBtn.textContent = 'Update Password';
      if (!active.length) { say('No verified email or mobile number is on this account, so the codes cannot be sent. Ask the Finance/Admin team for help.', true); cfg.saveBtn.disabled = true; return; }
      say('Your current password is correct. We are sending a code to ' + active.map(function (c) { return 'your ' + c.noun; }).join(' and to ') + '. Enter ' + (active.length > 1 ? 'both codes' : 'the code') + ' to finish.');
      active.forEach(function (c) { send(c.key); });
    }

    function fieldErrors(f) {
      var any = false;
      if (f.currentPassword) { cfg.setError(cfg.cur, f.currentPassword); any = true; }
      if (f.newPassword) { cfg.setError(cfg.nw, f.newPassword); any = true; }
      if (f.confirmPassword) { cfg.setError(cfg.conf, f.confirmPassword); any = true; }
      CHANNELS.forEach(function (c) { if (f[c.field]) { var el = codeInput(c.key); if (el) cfg.setError(el, f[c.field]); any = true; } });
      return any;
    }

    async function step1() {
      var cur = cfg.cur.value;
      if (!cur) { cfg.setError(cfg.cur, 'Type your current password'); cfg.banner('Type your current password first.'); cfg.cur.focus(); return; }
      if (!cfg.rulesMet()) { cfg.banner('Check the fields above — passwords must match and meet all requirements.'); return; }
      var btn = cfg.saveBtn, label = btn.textContent;
      btn.disabled = true; btn.textContent = 'Checking…';
      try {
        var res = await cfg.api('/auth/password/check', { method: 'POST', body: JSON.stringify({ currentPassword: cur, newPassword: cfg.nw.value, confirmPassword: cfg.conf.value }) });
        if (!res.required) { btn.disabled = false; btn.textContent = label; return finish(); }     // codes switched off on this server
        showCodeStage(res);
      } catch (err) {
        if (err.message === 'Not signed in') return;
        var f = err.fields || {};
        cfg.banner(fieldErrors(f) ? 'Please fix the highlighted fields.' : err.message);
        if (f.currentPassword) cfg.cur.focus();
      } finally { if (stage === 0) { btn.disabled = false; btn.textContent = label; } else if (active.length) btn.disabled = false; }
    }

    async function finish() {
      var body = { currentPassword: cfg.cur.value, newPassword: cfg.nw.value, confirmPassword: cfg.conf.value };
      var bad = false;
      if (info && info.required) {
        active.forEach(function (c) {
          var v = codeInput(c.key).value.trim();
          if (!/^\d{6}$/.test(v)) { cfg.setError(codeInput(c.key), 'Enter the 6-digit code sent to your ' + c.noun); bad = true; }
          body[c.field] = v;
        });
      }
      if (bad) { cfg.banner('Enter the 6-digit code from your email and from your mobile number.'); return; }
      var btn = cfg.saveBtn;
      btn.disabled = true; btn.textContent = 'Updating…';
      try {
        await cfg.api('/auth/password', { method: 'PUT', body: JSON.stringify(body) });
        cfg.toast('Password updated');
        cfg.onDone();
      } catch (err) {
        if (err.message === 'Not signed in') return;
        var f = err.fields || {};
        if (f.currentPassword || f.newPassword || f.confirmPassword) backToFields();      // the passwords have to be fixed first
        cfg.banner(fieldErrors(f) ? 'Please fix the highlighted fields.' : err.message);
      } finally { btn.disabled = false; btn.textContent = stage === 1 ? 'Update Password' : original; }
    }

    cfg.saveBtn.addEventListener('click', function () { cfg.banner(''); [cfg.cur, cfg.nw, cfg.conf].forEach(cfg.clearError); rows.querySelectorAll('input').forEach(cfg.clearError); return stage === 0 ? step1() : finish(); });
    box.querySelector('.pc-edit').addEventListener('click', function () { backToFields(); cfg.nw.focus(); });

    /* the current password is never pre-filled: random name, no autocomplete, read-only until the person clicks into it */
    cfg.cur.setAttribute('autocomplete', 'off');
    cfg.cur.setAttribute('name', 'typed-current-' + Math.random().toString(36).slice(2, 8));
    cfg.cur.setAttribute('data-lpignore', 'true'); cfg.cur.setAttribute('data-1p-ignore', 'true'); cfg.cur.setAttribute('data-form-type', 'other');
    cfg.cur.addEventListener('focus', function () { if (stage === 0) cfg.cur.readOnly = false; });
    [cfg.nw, cfg.conf].forEach(function (el) { el.setAttribute('autocomplete', 'new-password'); });

    function reset() {
      [cfg.cur, cfg.nw, cfg.conf].forEach(function (el) { el.value = ''; cfg.clearError(el); });
      backToFields();
      cfg.cur.readOnly = true;                      // read-only until clicked, so browsers cannot fill it in
      cfg.saveBtn.textContent = 'Continue';
      cfg.banner('');
    }
    reset();
    return { reset: reset };
  }

  window.PasswordChange = { create: create };
})();
