/* quote-guide.js — tells Finance what to do next on every quotation, and how urgent it is.
   One shared rule set, used by Sales Overview (approvals) and Quote Requests (the list), so both pages agree on the order.
     QuoteGuide.next(q) -> { text, score, tone: 'urgent' | 'soon' | 'ok', mine, late }
       text   the next action in plain words ('' when nothing is left to do)
       score  bigger = more urgent (approvals first, then jobs that can move forward, then waiting items)
       mine   true when Finance is the one who has to act (false: the cashier or the customer is)
   Reads only the fields the quote list already returns; it changes nothing. */
(function () {
  'use strict';
  const peso = (n) => '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const daysTo = (d) => (d ? Math.round((Date.parse(String(d).slice(0, 10)) - Date.parse(today())) / 864e5) : null);

  function base(q) {
    const t = q.terms || {}, custom = !q.sku, deliver = q.fulfillment === 'Delivery';
    switch (q.status) {
      case 'pending_approval': {
        const hrs = q.proposedAt ? Math.max(0, (Date.now() - q.proposedAt) / 36e5) : 0;
        return { text: 'Approve the cashier price of ' + peso(q.proposedAmount) + ', or pick a discount', score: 100 + Math.min(20, Math.floor(hrs)), mine: true };
      }
      case 'accepted':
        if (t.state === 'proposed') return { text: 'Approve the payment terms the cashier proposed', score: 95, mine: true };
        if (q.dueNow > 0) return { text: 'Waiting for the ' + peso(q.dueNow) + ' down payment \u2014 record it when it arrives', score: 45, mine: true };
        return { text: custom ? 'Issue the materials to start the job' : 'Start preparing the order', score: 85, mine: true };
      case 'preparing':
        return { text: custom ? 'Finish the job, then mark it ' + (deliver ? 'out for delivery' : 'ready for pickup') : 'Mark it ' + (deliver ? 'out for delivery' : 'ready for pickup') + ' when it is done', score: 60, mine: true };
      case 'ready':
        return q.balance > 0
          ? { text: 'Collect the balance of ' + peso(q.balance) + ', then mark it ' + (deliver ? 'delivered' : 'picked up'), score: 70, mine: true }
          : { text: 'Fully paid \u2014 mark it ' + (deliver ? 'delivered' : 'picked up'), score: 65, mine: true };
      case 'quoted':
        if (q.expired) return { text: 'The price expired \u2014 refresh it at today\u2019s costs', score: 50, mine: true };
        if (q.costStale) return { text: 'Material costs changed \u2014 refresh the price', score: 55, mine: true };
        return { text: 'Waiting for the customer to accept', score: 8, mine: false };
      case 'new': return { text: q.financeNote ? 'Sent back \u2014 waiting for the cashier to reprice' : 'Waiting for the cashier to price it', score: 10, mine: false };
      case 'awaiting_details': return { text: 'Waiting for the customer to send details', score: 5, mine: false };
      default: return { text: '', score: 0, mine: false };
    }
  }

  function next(q) {
    const g = base(q || {});
    const left = daysTo(q && q.neededBy);
    g.late = !!(q && q.lateForNeededBy);
    if (g.score >= 40) {                                   // only live work gets pushed up by the deadline
      if (g.late) { g.score += 15; g.text += ' \u2014 will miss the needed-by date'; }
      else if (left != null && left <= 3) { g.score += 10; g.text += ' \u2014 needed ' + (left <= 0 ? 'today' : 'in ' + left + ' day' + (left === 1 ? '' : 's')); }
    }
    g.tone = g.score >= 100 ? 'urgent' : g.score >= 60 ? 'soon' : 'ok';
    return g;
  }
  window.QuoteGuide = { next };
})();
