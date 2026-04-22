#!/usr/bin/env python3
# patch_cards_pos.py
# Adds Cards tab to contact drawer, Card on File to POS, and full charge flow

import sys

TARGET = 'index.html'

try:
    with open(TARGET, 'r', encoding='utf-8') as f:
        content = f.read()
except FileNotFoundError:
    print('ERROR: index.html not found.')
    sys.exit(1)

original_len = len(content)

# -------------------------------------------------------
# PATCH 1: Add Square Web Payments SDK to <head>
# -------------------------------------------------------
old1 = '<link rel="preconnect" href="https://fonts.googleapis.com">'
new1 = '<link rel="preconnect" href="https://fonts.googleapis.com">\n<script src="https://web.squarecdn.com/v1/square.js"></script>'

if old1 in content:
    content = content.replace(old1, new1, 1)
    print('PATCH 1: Square Web Payments SDK added to head.')
else:
    print('WARN: PATCH 1 pattern not found.')

# -------------------------------------------------------
# PATCH 2: Add Card on File tab to POS payment tabs
# -------------------------------------------------------
old2 = '''              <div class="pay-tabs">
                <button class="pay-tab active" id="pm-card" onclick="setPM(\'card\')">Card</button>
                <button class="pay-tab" id="pm-cash" onclick="setPM(\'cash\')">Cash</button>
                <button class="pay-tab" id="pm-other" onclick="setPM(\'other\')">Other</button>
              </div>'''

new2 = '''              <div class="pay-tabs">
                <button class="pay-tab active" id="pm-card" onclick="setPM(\'card\')">Card</button>
                <button class="pay-tab" id="pm-cash" onclick="setPM(\'cash\')">Cash</button>
                <button class="pay-tab" id="pm-other" onclick="setPM(\'other\')">Other</button>
                <button class="pay-tab hidden" id="pm-cof" onclick="setPM(\'cof\')">Card on File</button>
              </div>'''

if old2 in content:
    content = content.replace(old2, new2, 1)
    print('PATCH 2: Card on File tab added to POS.')
else:
    print('WARN: PATCH 2 POS tabs pattern not found.')

# -------------------------------------------------------
# PATCH 3: Add Card on File panel to POS payment section
# -------------------------------------------------------
old3 = '              <div id="pm-other-fields" class="hidden" style="margin-top:8px">'
new3 = '''              <div id="pm-cof-fields" class="hidden" style="margin-top:4px">
                <div id="pm-cof-display" style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px">
                  <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Card on File</div>
                  <div id="pm-cof-card-info" style="font-size:14px;font-weight:600"></div>
                </div>
              </div>
              <div id="pm-other-fields" class="hidden" style="margin-top:8px">'''

if old3 in content:
    content = content.replace(old3, new3, 1)
    print('PATCH 3: Card on File panel added to POS.')
else:
    print('WARN: PATCH 3 pattern not found.')

# -------------------------------------------------------
# PATCH 4: Add card CSS styles
# -------------------------------------------------------
old4 = '/* EMPTY STATE */'
new4 = '''/* CARD ON FILE */
.card-on-file{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px}
.card-brand-icon{width:36px;height:24px;background:var(--bg-input);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:var(--text-muted);flex-shrink:0}
.card-details{flex:1}
.card-number{font-size:13px;font-weight:600}
.card-exp{font-size:11px;color:var(--text-muted)}
.sq-card-form{background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:12px;min-height:44px}

/* EMPTY STATE */'''

if old4 in content:
    content = content.replace(old4, new4, 1)
    print('PATCH 4: Card CSS styles added.')
else:
    print('WARN: PATCH 4 pattern not found.')

# -------------------------------------------------------
# PATCH 5: Add all JS functions before closing </script>
# -------------------------------------------------------
new_js = '''
// =====================================================
// CARDS TAB - CONTACT DRAWER
// =====================================================
function renderCardsTab(contact){
  const cards=(contact&&contact.squareCards)||[];
  const hasSquare=!!(contact&&contact.squareCustomerId);
  let h='<div class="sec-label" style="margin-bottom:12px">Payment Methods</div>';
  if(cards.length){
    h+=cards.map(function(c){
      return '<div class="card-on-file" style="margin-bottom:8px">'+
        '<div class="card-brand-icon">'+esc(c.brand?c.brand.slice(0,4):'CARD')+'</div>'+
        '<div class="card-details">'+
          '<div class="card-number">'+esc(c.brand||'Card')+' ending in '+esc(c.last4||'****')+'</div>'+
          '<div class="card-exp">Expires '+esc(c.expMonth||'?')+'/'+esc(c.expYear||'?')+'</div>'+
        '</div>'+
        '<button class="btn btn-danger btn-sm" onclick="removeCardFromContact(\''+esc(contact.id)+'\',\''+esc(c.id)+'\')">Remove</button>'+
      '</div>';
    }).join('');
  }else{
    h+='<div class="empty-state" style="padding:24px 0">'+
      '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 10px;display:block;opacity:.3" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>'+
      '<div style="font-size:13px;color:var(--text-muted);margin-bottom:12px">No card on file</div>'+
    '</div>';
  }
  if(hasSquare){
    h+='<button class="btn btn-purple btn-sm" onclick="openAddCardModal(\''+esc(contact.id)+'\')">+ Add Card</button>';
  }else{
    h+='<div style="font-size:12px;color:var(--text-muted);margin-top:8px">To save a card, first import this contact from Square or connect their Square account.</div>';
  }
  return h;
}

function removeCardFromContact(contactId,cardId){
  const c=getContact(contactId);
  if(!c)return;
  c.squareCards=(c.squareCards||[]).filter(function(x){return x.id!==cardId});
  saveData();
  if(state.drawer===contactId&&state.dTab==='cards'){
    const body=document.getElementById('drawer-tab-body');
    if(body)body.innerHTML=renderCardsTab(c);
  }
  toast('Card removed.','success');
}

// =====================================================
// ADD CARD MODAL
// =====================================================
async function openAddCardModal(contactId){
  const contact=getContact(contactId);
  if(!contact||!contact.squareCustomerId){toast('No Square customer linked.','error');return}
  state.modal={type:'add-card',id:contactId};
  document.getElementById('modal-title').textContent='Add Card on File';
  document.getElementById('modal-box').className='modal';
  document.getElementById('modal-body').innerHTML=
    '<div style="font-size:13px;color:var(--text-muted);margin-bottom:14px">Enter card details for '+esc(contact.name)+'. Card will be saved securely in Square.</div>'+
    '<div id="sq-card-container" class="sq-card-form"></div>'+
    '<div id="sq-card-errors" style="color:#f87171;font-size:12px;margin-top:6px;min-height:18px"></div>';
  document.getElementById('modal-foot').innerHTML=
    '<button class="btn btn-ghost" onclick="closeModal()">Cancel</button>'+
    '<button class="btn btn-primary" id="save-card-btn" onclick="submitAddCard()">Save Card</button>';
  document.getElementById('modal-overlay').classList.add('open');
  await initSquareCardForm();
}

let sqCard=null;
async function initSquareCardForm(){
  const errEl=document.getElementById('sq-card-errors');
  try{
    const cfgRes=await fetch('/api/square/config');
    const cfg=await cfgRes.json();
    if(!cfg.appId){if(errEl)errEl.textContent='Square not configured.';return}
    if(!window.Square){if(errEl)errEl.textContent='Square SDK not loaded.';return}
    const payments=window.Square.payments(cfg.appId,'production');
    sqCard=await payments.card({style:{'.input-container':{borderColor:'transparent',borderRadius:'8px'},'input':{color:'#ede8ff',fontFamily:'DM Sans,sans-serif'}}});
    await sqCard.attach('#sq-card-container');
  }catch(e){
    console.error('Square card form error:',e);
    if(errEl)errEl.textContent='Could not load card form. '+e.message;
  }
}

async function submitAddCard(){
  const errEl=document.getElementById('sq-card-errors');
  const btn=document.getElementById('save-card-btn');
  if(!sqCard){if(errEl)errEl.textContent='Card form not ready.';return}
  if(btn)btn.disabled=true;
  if(btn)btn.textContent='Saving...';
  try{
    const result=await sqCard.tokenize();
    if(result.status!=='OK'){
      const msgs=(result.errors||[]).map(function(e){return e.message}).join(', ');
      if(errEl)errEl.textContent=msgs||'Card error.';
      if(btn){btn.disabled=false;btn.textContent='Save Card'}
      return;
    }
    const contactId=state.modal&&state.modal.id;
    const contact=getContact(contactId);
    if(!contact){if(errEl)errEl.textContent='Contact not found.';return}
    const sq=db.settings.square||{};
    const saveRes=await fetch('/api/square/save-card',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({accessToken:sq.accessToken,customerId:contact.squareCustomerId,sourceId:result.token,cardholderName:contact.name||''})
    });
    const saveData2=await saveRes.json();
    if(saveData2.error){if(errEl)errEl.textContent=saveData2.error;if(btn){btn.disabled=false;btn.textContent='Save Card'}return}
    if(!contact.squareCards)contact.squareCards=[];
    contact.squareCards.push(saveData2.card);
    saveData();
    closeModal();
    sqCard=null;
    toast('Card saved successfully.','success');
    if(state.drawer===contactId&&state.dTab==='cards'){
      const body=document.getElementById('drawer-tab-body');
      if(body)body.innerHTML=renderCardsTab(contact);
    }
    updatePosCoFTab();
  }catch(e){
    console.error('Save card error:',e);
    if(errEl)errEl.textContent='Failed to save card.';
    if(btn){btn.disabled=false;btn.textContent='Save Card'}
  }
}

// =====================================================
// POS CARD ON FILE
// =====================================================
function updatePosCoFTab(){
  const contactId=document.getElementById('pos-c-id')&&document.getElementById('pos-c-id').value;
  const contact=contactId?getContact(contactId):null;
  const cards=(contact&&contact.squareCards)||[];
  const tab=document.getElementById('pm-cof');
  if(!tab)return;
  if(cards.length>0){
    tab.classList.remove('hidden');
    const info=document.getElementById('pm-cof-card-info');
    const first=cards[0];
    if(info)info.textContent=(first.brand||'Card')+' ending in '+(first.last4||'****');
  }else{
    tab.classList.add('hidden');
    if(state.posPM==='cof')setPM('card');
  }
}

// Override setPM to handle cof
const _origSetPM=typeof setPM==='function'?setPM:null;
function setPM(m){
  state.posPM=m;
  ['card','cash','other','cof'].forEach(function(x){
    const btn=document.getElementById('pm-'+x);
    if(btn)btn.classList.toggle('active',x===m);
  });
  ['card','cash','other','cof'].forEach(function(x){
    const f=document.getElementById('pm-'+x+'-fields');
    if(f)f.classList.toggle('hidden',x!==m);
  });
}

// =====================================================
// CHARGE CARD ON FILE
// =====================================================
async function chargeCardOnFile(){
  const contactId=document.getElementById('pos-c-id')&&document.getElementById('pos-c-id').value;
  const contact=contactId?getContact(contactId):null;
  const cards=(contact&&contact.squareCards)||[];
  if(!cards.length){toast('No card on file for this contact.','error');return}
  const sq=db.settings.square||{};
  if(!sq.accessToken){toast('Square not connected.','error');return}
  const total=parseFloat((document.getElementById('pos-total').textContent||'0').replace('$',''))||0;
  if(total<=0){toast('Total must be greater than $0.','error');return}
  const card=cards[0];
  const amountCents=Math.round(total*100);
  const staffId=document.getElementById('pos-staff')&&document.getElementById('pos-staff').value;
  const staff=getUserById(staffId);
  const notes=document.getElementById('pos-notes')&&document.getElementById('pos-notes').value||'';
  state.modal={type:'charge-cof',data:{contact,card,amountCents,total,staffId,staff,notes}};
  document.getElementById('modal-title').textContent='Confirm Charge';
  document.getElementById('modal-box').className='modal';
  document.getElementById('modal-body').innerHTML=
    '<div style="margin-bottom:16px">'+
      '<div style="font-size:13px;color:var(--text-muted);margin-bottom:4px">Customer</div>'+
      '<div style="font-size:14px;font-weight:600">'+esc(contact.name)+'</div>'+
    '</div>'+
    '<div style="margin-bottom:16px">'+
      '<div style="font-size:13px;color:var(--text-muted);margin-bottom:4px">Card</div>'+
      '<div style="font-size:14px;font-weight:600">'+esc(card.brand||'Card')+' ending in '+esc(card.last4||'****')+'</div>'+
    '</div>'+
    '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:14px">'+
      '<div style="display:flex;justify-content:space-between;font-size:13px;color:var(--text-muted);padding:3px 0"><span>Total</span><span style="font-family:Syne,sans-serif;font-size:18px;font-weight:800;color:var(--orange)">$'+total.toFixed(2)+'</span></div>'+
    '</div>'+
    '<div class="warn-box" style="margin-top:14px">This will charge the card immediately. This action cannot be undone.</div>';
  document.getElementById('modal-foot').innerHTML=
    '<button class="btn btn-ghost" onclick="closeModal()">Cancel</button>'+
    '<button class="btn btn-primary" id="confirm-charge-btn" onclick="confirmChargeCoF()">Charge $'+total.toFixed(2)+'</button>';
  document.getElementById('modal-overlay').classList.add('open');
}

async function confirmChargeCoF(){
  const btn=document.getElementById('confirm-charge-btn');
  if(btn){btn.disabled=true;btn.textContent='Processing...'}
  const d=state.modal&&state.modal.data;
  if(!d){closeModal();return}
  const sq=db.settings.square||{};
  try{
    const r=await fetch('/api/square/charge',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        accessToken:sq.accessToken,
        cardId:d.card.id,
        customerId:d.contact.squareCustomerId||'',
        amountCents:d.amountCents,
        note:d.notes||'MySpark+ CRM'
      })
    });
    const data=await r.json();
    if(data.error){
      const pmt={id:uid(),contactId:d.contact.id,contactName:d.contact.name,amount:d.total,tip:0,method:'card_on_file',status:'failed',failReason:data.error,staffId:d.staffId,staffName:d.staff&&d.staff.name||'',notes:d.notes,createdAt:now_()};
      db.payments.push(pmt);saveData();
      closeModal();
      toast('Charge failed: '+data.error,'error');
      return;
    }
    const pmt={
      id:uid(),
      contactId:d.contact.id,
      contactName:d.contact.name,
      squarePaymentId:data.payment&&data.payment.id||'',
      amount:d.total,tip:0,
      method:'card_on_file',
      cardLast4:d.card.last4,
      cardBrand:d.card.brand,
      status:'completed',
      staffId:d.staffId,
      staffName:d.staff&&d.staff.name||'',
      notes:d.notes,
      createdAt:now_()
    };
    db.payments.push(pmt);
    saveData();
    closeModal();
    toast('Payment of $'+d.total.toFixed(2)+' processed successfully.','success');
    resetPos();
  }catch(e){
    console.error('Charge error:',e);
    if(btn){btn.disabled=false;btn.textContent='Charge $'+d.total.toFixed(2)}
    toast('Charge failed. Check connection.','error');
  }
}

function resetPos(){
  state.posItems=[];state.posTip='15';state.posPM='card';
  const fields=['pos-c-inp','pos-desc','pos-price','pos-notes','pos-card-num','pos-exp','pos-cvv','pos-zip','pos-other-ref'];
  fields.forEach(function(id){const el=document.getElementById(id);if(el)el.value=''});
  const cid=document.getElementById('pos-c-id');if(cid)cid.value='';
  updatePosCoFTab();
  renderPayments();
}
'''

last_idx = content.rfind('</script>')
if last_idx != -1:
    content = content[:last_idx] + new_js + '\n' + content[last_idx:]
    print('PATCH 5: Cards and charge JS functions added.')
else:
    print('ERROR: Could not find closing </script>.')

# -------------------------------------------------------
# PATCH 6: Hook CoF tab update into POS contact selection
# -------------------------------------------------------
old6 = "function posCSelect(id,name){"
new6 = "function posCSelect(id,name){\n  setTimeout(updatePosCoFTab,50);"

if old6 in content:
    content = content.replace(old6, new6, 1)
    print('PATCH 6: CoF tab hook added to posCSelect.')
else:
    print('WARN: PATCH 6 posCSelect not found.')

# -------------------------------------------------------
# PATCH 7: Wire reviewCharge to use chargeCardOnFile for cof
# -------------------------------------------------------
old7 = "function reviewCharge(){"
new7 = "function reviewCharge(){\n  if(state.posPM==='cof'){chargeCardOnFile();return}"

if old7 in content:
    content = content.replace(old7, new7, 1)
    print('PATCH 7: reviewCharge wired to CoF flow.')
else:
    print('WARN: PATCH 7 reviewCharge not found.')

# -------------------------------------------------------
# Write output
# -------------------------------------------------------
if len(content) == original_len:
    print('\nWARN: File unchanged. Check warnings above.')
else:
    with open(TARGET, 'w', encoding='utf-8') as f:
        f.write(content)
    print('\nDone. index.html patched successfully.')
