/* POS Management tabs: keep the existing POS sales and cash-shift reports intact. */
(function(){'use strict';
function init(){
 const tabs=Array.from(document.querySelectorAll('[data-pos-tab]'));
 const sales=document.getElementById('posTransactionsPanel');
 const shifts=document.getElementById('posShiftsPanel');
 if(!tabs.length||!sales||!shifts)return;
 function show(name){const isShift=name==='shifts';sales.hidden=isShift;shifts.hidden=!isShift;tabs.forEach(t=>{const active=t.dataset.posTab===name;t.classList.toggle('active',active);t.setAttribute('aria-selected',String(active));t.tabIndex=active?0:-1;});}
 tabs.forEach(t=>t.addEventListener('click',()=>show(t.dataset.posTab)));show('transactions');
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
