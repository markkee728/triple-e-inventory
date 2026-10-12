/* Mailgun mailer + email templates (no extra npm package: uses Node's built-in fetch).

   Needs these in backend/.env (see .env.example):
     MAILGUN_API_KEY   your Mailgun private API key
     MAILGUN_DOMAIN    the sending domain you verified in Mailgun, e.g. mg.triplee-metal.com
     MAILGUN_REGION    us (default) or eu
     MAIL_FROM         e.g. Triple E Metal Products <no-reply@mg.triplee-metal.com>
     APP_BASE_URL      the public address of the website, e.g. https://inventory.triplee-metal.com

   Without MAILGUN_API_KEY / MAILGUN_DOMAIN nothing is sent: the email is printed in the server console instead,
   so the sign-up link can still be tested on a developer computer. */
const fs = require('fs');
const path = require('path');

const TEMPLATE_DIR = path.join(__dirname, 'emails');
const escapeHtml = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// {{name}} is HTML-escaped. Same placeholder style as Mailgun templates, so a file can be pasted into Mailgun's editor too.
function renderTemplate(file, vars, { html = true } = {}) {
  const src = fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8');
  return src.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => {
    if (!(key in vars)) return '';
    return html ? escapeHtml(vars[key]) : String(vars[key]);
  });
}

const isConfigured = () => !!(process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN);

async function sendMail({ to, subject, html, text, tag }) {
  const from = process.env.MAIL_FROM || ('Triple E Metal Products <no-reply@' + (process.env.MAILGUN_DOMAIN || 'localhost') + '>');
  if (!isConfigured()) {
    console.warn('[mail] Mailgun is not set up (MAILGUN_API_KEY / MAILGUN_DOMAIN missing). Email NOT sent.');
    console.warn('[mail] To: ' + to + '\n[mail] Subject: ' + subject + '\n' + text);
    return { sent: false, reason: 'Email is not set up on the server yet' };
  }
  const base = String(process.env.MAILGUN_REGION || 'us').toLowerCase() === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
  const body = new URLSearchParams({ from, to, subject, html, text });
  if (tag) body.append('o:tag', tag);
  body.append('o:tracking-clicks', 'no');      // keep the sign-up link exactly as written (Mailgun would otherwise rewrite it)
  body.append('o:tracking-opens', 'no');
  try {
    const res = await fetch(`${base}/v3/${encodeURIComponent(process.env.MAILGUN_DOMAIN)}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from('api:' + process.env.MAILGUN_API_KEY).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body,
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      console.error('[mail] Mailgun refused the message (' + res.status + '): ' + detail);
      return { sent: false, reason: res.status === 401 ? 'Mailgun API key was rejected' : 'Mailgun could not send the email (' + res.status + ')' };
    }
    return { sent: true };
  } catch (err) {
    console.error('[mail] could not reach Mailgun:', err.message);
    return { sent: false, reason: 'Could not reach Mailgun' };
  }
}

function sendCashierInvite({ to, recipientName, roleLabel, inviterName, signupUrl, expiresHours }) {
  const hours = Number(expiresHours) || 72;
  const expiresIn = hours % 24 === 0 ? (hours / 24) + (hours === 24 ? ' day' : ' days') : hours + ' hours';
  const vars = {
    recipientName: recipientName || 'there', roleLabel, inviterName: inviterName || 'An administrator',
    signupUrl, expiresIn, toEmail: to, year: new Date().getFullYear()
  };
  return sendMail({
    to,
    subject: 'You\'re invited to Triple E Metal Products — set up your ' + roleLabel + ' account',
    html: renderTemplate('cashier-invite.html', vars),
    text: renderTemplate('cashier-invite.txt', vars, { html: false }),
    tag: 'staff-invite'
  });
}

module.exports = { sendMail, sendCashierInvite, renderTemplate, isConfigured, escapeHtml };
