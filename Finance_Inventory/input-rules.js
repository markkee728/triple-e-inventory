/* input-rules.js — one rule for every money / cash textbox in the system.

   Mark a box with  data-money  and it behaves the same everywhere:
     - letters and symbols are never accepted (only digits and one dot)
     - commas appear while typing:        2000      ->  2,000
     - at most 2 decimals, at most 10 whole digits
     - when the person leaves the box:    2000      ->  2,000.00      (.5 -> 0.50, empty stays empty)
   The box holds the formatted text, so any code that reads it must use  MoneyInput.parse(el.value)  or  MoneyInput.raw(el.value)
   (both ignore the commas and the peso sign).  Quantities (kg, pcs, sheets) are NOT money and are not touched.

   Works for boxes that are drawn later too (modals, tables), because it listens on the document.
   Programmatic fill:  MoneyInput.set(el, 1500)   or   MoneyInput.refresh(rootElement)  after a whole form was filled in. */
(function () {
  'use strict';
  var MAX_WHOLE = 10;
  var SEL = 'input[data-money]';

  function raw(v) { return String(v == null ? '' : v).replace(/[\u20B1,\s]/g, ''); }
  function valid(s) { return s !== '' && s !== '.' && /^\d*\.?\d*$/.test(s); }
  function parse(v) { var s = raw(v); return valid(s) ? Number(s) : NaN; }
  function fmt(v) {                                        // 2000 -> "2,000.00"; anything that is not a number -> ""
    var n = parse(v); if (!isFinite(n)) return '';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // while typing: strip what is not allowed, group the digits with commas, keep the cursor where it was
  function live(el) {
    var v = el.value, caret = el.selectionStart == null ? v.length : el.selectionStart;
    var before = v.slice(0, caret).replace(/[^\d.]/g, '').length;      // digits (and the dot) to the left of the cursor
    var s = v.replace(/[^\d.]/g, ''), i = s.indexOf('.');
    var whole = (i < 0 ? s : s.slice(0, i)).slice(0, MAX_WHOLE).replace(/^0+(?=\d)/, '');
    var dec = i < 0 ? null : s.slice(i + 1).replace(/\./g, '').slice(0, 2);
    var grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    var out = dec === null ? grouped : (grouped || '0') + '.' + dec;
    if (out === v) return;
    el.value = out;
    var pos = 0, seen = 0;
    while (pos < out.length && seen < before) { if (/[\d.]/.test(out.charAt(pos))) seen++; pos++; }
    try { el.setSelectionRange(pos, pos); } catch (e) { /* not focusable / not supported */ }
  }

  function finish(el) { var f = fmt(el.value); if (el.value !== f) el.value = f; }
  function prepare(el) {
    if (el.type === 'number') el.type = 'text';             // a number box cannot hold commas
    el.setAttribute('inputmode', 'decimal'); el.setAttribute('autocomplete', 'off'); el.removeAttribute('min'); el.removeAttribute('max'); el.removeAttribute('step');
  }
  function set(el, v) { if (!el) return; prepare(el); el.value = v == null || v === '' ? '' : (fmt(v) || ''); }
  function refresh(root) { Array.prototype.forEach.call((root || document).querySelectorAll(SEL), function (el) { prepare(el); if (el.value) finish(el); }); }

  document.addEventListener('input', function (e) { var el = e.target; if (el && el.matches && el.matches(SEL)) live(el); }, true);     // capture: runs before the page's own handler reads the box
  document.addEventListener('focusout', function (e) { var el = e.target; if (el && el.matches && el.matches(SEL)) finish(el); }, true);
  document.addEventListener('keydown', function (e) {                                                                                        // a letter never even shows up
    var el = e.target; if (!el || !el.matches || !el.matches(SEL)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    if (!/[\d.]/.test(e.key)) e.preventDefault();
  }, true);
  document.addEventListener('focusin', function (e) { var el = e.target; if (el && el.matches && el.matches(SEL)) prepare(el); }, true);
  document.addEventListener('DOMContentLoaded', function () { refresh(); });

  window.MoneyInput = { raw: raw, parse: parse, fmt: fmt, set: set, refresh: refresh };
})();