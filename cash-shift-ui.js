(() => {
 const $ = id => document.getElementById(id);
 const fmt = n => '₱' + Number(n || 0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
 const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
 let current=null;
 async function request(url,options={}) {
  const r=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json'},...options});
  const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'Request failed');return d;
 }
 async function refresh() {
  try {current=await request('/api/pos/cash-shifts/current');
   $('shiftStatus').textContent=current?'Open shift #'+current.id:'No open shift';
   $('shiftOpenPanel').hidden=!!current;$('shiftClosePanel').hidden=!current;
   $('shiftCheckoutWarning').hidden=!!current;
   if(current){$('shiftOpening').textContent=fmt(current.openingCash);$('shiftSales').textContent=fmt(current.cashSales);$('shiftExpected').textContent=fmt(current.expectedCash);$('shiftTransactions').textContent=current.cashTransactions;}
  } catch(e){$('shiftStatus').textContent='Could not load shift: '+e.message;}
 }
 async function history(){
  try{const rows=await request('/api/pos/cash-shifts/history');
   $('shiftHistory').innerHTML=rows.length?rows.map(s=>`<tr><td>#${s.id}</td><td>${esc(new Date(s.openedAt).toLocaleString('en-PH'))}</td><td>${s.closedAt?esc(new Date(s.closedAt).toLocaleString('en-PH')):'Open'}</td><td>${fmt(s.cashSales)}</td><td>${s.difference==null?'—':fmt(s.difference)}</td></tr>`).join(''):'<tr><td colspan="5">No shifts yet.</td></tr>';
  }catch(e){$('shiftHistory').textContent=e.message;}
 }
 $('shiftOpenBtn').onclick=async()=>{
  const amount=Number($('shiftOpeningInput').value);if(!$('shiftOpeningInput').value.trim())return alert('Enter opening cash.');
  try{await request('/api/pos/cash-shifts/open',{method:'POST',body:JSON.stringify({openingCash:amount})});await refresh();await history();}
  catch(e){alert(e.message);}
 };
 $('shiftCloseBtn').onclick=async()=>{
  if(!$('shiftClosingInput').value.trim())return alert('Count and enter the actual cash first.');
  const amount=Number($('shiftClosingInput').value);
  if(!confirm('Close this cash shift with '+fmt(amount)+' counted?'))return;
  try{const s=await request('/api/pos/cash-shifts/close',{method:'POST',body:JSON.stringify({closingCash:amount,note:$('shiftNote').value})});alert('Shift closed. Difference: '+fmt(s.difference));$('shiftClosingInput').value='';$('shiftNote').value='';await refresh();await history();}
  catch(e){alert(e.message);}
 };
 document.querySelector('[data-page="shift"]').addEventListener('click',()=>{refresh();history();});
 window.refreshCashShift=refresh;
 refresh();
})();
