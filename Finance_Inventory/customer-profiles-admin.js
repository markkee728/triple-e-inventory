/* Finance-only, read-only customer directory using the existing /api/users endpoint.
   Customer registration fields remain in users and are not duplicated. */
(function(){'use strict';
 const byId=id=>document.getElementById(id);let customers=[];
 const escape=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function render(){const body=byId('customerRows');if(!body)return;const q=(byId('customerSearch').value||'').trim().toLowerCase();const rows=customers.filter(u=>[u.name,u.email,u.username].some(v=>String(v||'').toLowerCase().includes(q)));byId('customerCount').textContent=customers.length+' registered customer(s)';body.innerHTML=rows.length?rows.map(u=>'<tr><td>'+escape(u.name)+'</td><td>'+escape(u.email)+'</td><td>'+escape(u.username)+'</td><td>'+escape(u.status)+'</td><td>'+escape(u.lastLogin||'Never')+'</td></tr>').join(''):'<tr><td colspan="5">No matching customers.</td></tr>';}
 async function load(){const body=byId('customerRows');if(!body)return;body.innerHTML='<tr><td colspan="5">Loading…</td></tr>';try{const response=await fetch('/api/users',{credentials:'include'});if(!response.ok)throw Error('Could not load customer accounts ('+response.status+').');const data=await response.json();customers=(Array.isArray(data)?data:[]).filter(u=>u.roleKey==='customer');render();}catch(err){body.innerHTML='<tr><td colspan="5">'+escape(err.message)+'</td></tr>';byId('customerCount').textContent='Unavailable';}}
 document.addEventListener('DOMContentLoaded',()=>{byId('customerRefresh')?.addEventListener('click',load);byId('customerSearch')?.addEventListener('input',render);document.querySelectorAll('[data-page="customers"]').forEach(b=>b.addEventListener('click',load));});
})();
