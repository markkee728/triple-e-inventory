/* SMS sending through TextBee (https://textbee.dev): your own Android phone is the SMS gateway.

   Set these in backend/.env (see .env.example):
     TEXTBEE_API_KEY    API key from app.textbee.dev/dashboard
     TEXTBEE_DEVICE_ID  Device ID of the phone, from the Devices page of the dashboard
     SMS_EVENTS         optional, comma-separated list of order events to text (default: all of them)

   Without the API key and device ID nothing is sent and the text is only printed in the server console.
   Sending never blocks or breaks an order: a failed text is logged and the function returns { sent: false }. */

const env = (k) => String(process.env[k] || '').trim();
const isConfigured = () => !!(env('TEXTBEE_API_KEY') && env('TEXTBEE_DEVICE_ID'));

// 0917 123 4567 / 09171234567 / +63 917 123 4567  ->  +639171234567
function toE164(raw) {
  const p = String(raw || '').replace(/[\s().-]/g, '');
  if (/^\+639\d{9}$/.test(p)) return p;
  if (/^09\d{9}$/.test(p)) return '+63' + p.slice(1);
  if (/^639\d{9}$/.test(p)) return '+' + p;
  return null;
}

async function sendSms({ to, message }) {
  const number = toE164(to);
  if (!number) return { sent: false, reason: 'no valid mobile number' };
  if (!isConfigured()) {
    console.log(`[sms] TextBee is not set up, so this text was NOT sent.\n  to: ${number}\n  ${message}`);
    return { sent: false, reason: 'TextBee is not configured' };
  }
  const base = env('TEXTBEE_BASE_URL') || 'https://api.textbee.dev/api/v1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${base}/gateway/devices/${encodeURIComponent(env('TEXTBEE_DEVICE_ID'))}/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env('TEXTBEE_API_KEY') },
      body: JSON.stringify({ recipients: [number], message }),
      signal: ctrl.signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { sent: false, reason: `TextBee answered ${res.status} ${body.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.name === 'AbortError' ? 'TextBee did not answer in time' : err.message };
  } finally { clearTimeout(timer); }
}

// which order events are texted (SMS_EVENTS empty = all)
function eventEnabled(ev) {
  const list = env('SMS_EVENTS');
  if (!list) return true;
  return list.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).includes(String(ev).toLowerCase());
}

module.exports = { sendSms, toE164, isConfigured, eventEnabled };
