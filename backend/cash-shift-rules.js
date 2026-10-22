// cash-shift-rules.js — the pure decisions behind the cashier's "Open cash shift" gate (no database, no clock of its own).
// cash-shifts.js feeds these the facts; test/cash-shift-gate.test.js proves every rule.
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const cents = (x) => Math.round(Number(x) * 100);

const DEFAULT_REASON_THRESHOLD = 20;   // pesos; Finance changes it on the Cash Shifts screen (cash_shift_rules)

/* Which screen the cashier gets right after signing in.
   clock   = { state: 'before' | 'open' | 'after', date: 'YYYY-MM-DD' }  (Philippine time)
   current = the cashier's open shift as { id, openedDay: 'YYYY-MM-DD' }, or null
   Order matters: a shift left open from an earlier day is always handled first, even after closing time. */
function gateState({ clock, current, canOpenShift }) {
  if (current) return current.openedDay < clock.date ? 'close_previous' : 'open';
  if (canOpenShift) return 'can_open';
  return clock.state === 'before' ? 'too_early' : 'store_closed';
}

/* Opening cash to pre-fill = what the last closed shift counted, minus the deposit taken out of the drawer at that close. */
function suggestOpening(prev) {
  if (!prev || prev.closingCash == null) return null;
  const deposit = Math.min(Number(prev.closingDeposit) || 0, Number(prev.closingCash));
  return { amount: r2(Number(prev.closingCash) - deposit), closingCash: r2(prev.closingCash), deposit: r2(deposit),
    fromShiftId: prev.id, cashierName: prev.cashierName || null, closedAt: prev.closedAt || null };
}

/* A reason is needed only when the drawer is off by MORE than the threshold (an exact match to the limit passes). */
function reasonRequired(difference, threshold) {
  return cents(Math.abs(difference)) > cents(threshold);
}

/* The deposit is taken after counting: it cannot be negative or more than what was counted. */
function depositProblem(deposit, counted) {
  if (!Number.isFinite(deposit) || deposit < 0) return 'Enter the deposit as 0 or more.';
  if (cents(deposit) > cents(counted)) return 'The deposit cannot be more than the cash you counted.';
  return null;
}

module.exports = { DEFAULT_REASON_THRESHOLD, gateState, suggestOpening, reasonRequired, depositProblem, r2 };
