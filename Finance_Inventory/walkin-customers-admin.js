/* Finance: Walk-in Customers tab inside Customer Profiles.
   Walk-in customers are not accounts. They are the name / phone a cashier typed on a POS sale, grouped by phone number
   (or by name when there is no phone). Voided sales are ignored and returned amounts are taken off the total. */
(function(){'use strict';
 const $=id=>document.getElementById(id);
 const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const peso=n=>'₱'+Number(n).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
 const when=t=>new Date(t).toLocaleString('en-PH',{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
 let people=[];
 function group(sales){
  const map=new Map();
  sales.filter(s=>(s.customerName||s.customerPhone)&&s.status!=='Voided').forEach(s=>{
   const phone=(s.customerPhone||'').replace(/[^0-9+]/g,'');
   const key=phone?'p:'+phone:'n:'+String(s.customerName).trim().toLowerCase();
   let c=map.get(key);if(!c){c={name:'',phone:'',count:0,spent:0,last:0};map.set(key,c);}
   if(s.createdAt>=c.last){c.last=s.createdAt;c.name=s.customerName||c.name;c.phone=s.customerPhone||c.phone;}
   c.count++;c.spent+=Number(s.total)-Number(s.refunded||0);
  });
  return Array.from(map.values()).sort((a,b)=>b.last-a.last);
 }
 function render(){
  const body=$('walkinRows');if(!body)return;
  const q=($('walkinSearch')?.value||'').trim().toLowerCase();
  const rows=people.filter(c=>!q||(c.name+' '+c.phone).toLowerCase().includes(q));
  $('walkinCount').textContent=people.length+' walk-in customer(s)';
  $('walkinShowing').textContent='Showing '+rows.length+' of '+people.length+' walk-in customers';
  body.innerHTML=rows.length?rows.map(c=>'<tr><td>'+esc(c.name||'—')+'</td><td class="dim">'+esc(c.phone||'—')+'</td><td>'+c.count+'</td><td>'+peso(c.spent)+'</td><td class="dim">'+esc(when(c.last))+'</td></tr>').join(''):'<tr><td colspan="5" class="customer-empty">No walk-in customers yet. They appear here when a cashier enters a name or phone on a POS sale.</td></tr>';
 }
 async function load(){
  const body=$('walkinRows');if(!body)return;
  body.innerHTML='<tr><td colspan="5" class="customer-empty">Loading walk-in customers…</td></tr>';
  try{const res=await fetch('/api/pos/sales?all=1',{credentials:'include'});if(!res.ok)throw Error('Could not load POS sales ('+res.status+').');people=group(await res.json());render();}
  catch(err){body.innerHTML='<tr><td colspan="5" class="customer-empty">'+esc(err.message)+'</td></tr>';$('walkinCount').textContent='Unavailable';}
 }
 function show(tab){
  const walk=tab==='walk';
  $('registeredDirectory').hidden=walk;$('walkinDirectory').hidden=!walk;
  document.querySelectorAll('[data-cust-tab]').forEach(b=>{const on=b.dataset.custTab===tab;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));});
  if(walk)load();
 }
 document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('[data-cust-tab]').forEach(b=>b.addEventListener('click',()=>show(b.dataset.custTab)));
  $('walkinRefresh')?.addEventListener('click',load);
  $('walkinSearch')?.addEventListener('input',render);
 });
})();
