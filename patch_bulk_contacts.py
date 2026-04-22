#!/usr/bin/env python3
# patch_bulk_contacts.py
# Adds bulk selection, bulk actions, and archive to contacts table

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
# PATCH 1: Add cSelected and cShowArchived to state
# -------------------------------------------------------
old1 = "cPage:1,cSearch:'',cType:'',cStatus:'',cTag:'',cSort:{col:'name',dir:'asc'},"
new1 = "cPage:1,cSearch:'',cType:'',cStatus:'',cTag:'',cSort:{col:'name',dir:'asc'},cSelected:new Set(),cShowArchived:false,"

if old1 in content:
    content = content.replace(old1, new1, 1)
    print('PATCH 1: cSelected and cShowArchived added to state.')
else:
    print('WARN: PATCH 1 pattern not found.')

# -------------------------------------------------------
# PATCH 2: Add bulk bar CSS
# -------------------------------------------------------
old2 = '/* EMPTY STATE */'
new2 = '''/* BULK ACTION BAR */
.bulk-bar{background:var(--bg-card);border:1px solid var(--purple-border);border-radius:var(--radius);
  padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bulk-count{font-size:13px;font-weight:600;color:var(--purple-light)}
.bulk-select-all-btn{background:none;border:none;color:var(--purple-light);cursor:pointer;
  font-family:'DM Sans',sans-serif;font-size:12px;font-weight:600;padding:0;text-decoration:underline}
.cb-col{width:36px;padding:10px 8px!important}
input[type=checkbox]{cursor:pointer;accent-color:var(--purple);width:15px;height:15px}
.archive-badge{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
  padding:2px 6px;border-radius:4px;background:rgba(245,158,11,.15);color:#fbbf24;margin-left:6px}

/* EMPTY STATE */'''

if old2 in content:
    content = content.replace(old2, new2, 1)
    print('PATCH 2: Bulk bar CSS added.')
else:
    print('WARN: PATCH 2 pattern not found.')

# -------------------------------------------------------
# PATCH 3: Add bulk bar HTML and archive button to contacts panel
# -------------------------------------------------------
old3 = '''        <div class="toolbar">
          <div class="search-box"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input id="c-search" type="text" placeholder="Search contacts..." oninput="onCSearch(this.value)"></div>'''

new3 = '''        <div id="bulk-bar" class="bulk-bar hidden">
          <span class="bulk-count" id="bulk-count"></span>
          <span id="bulk-select-all-wrap" class="hidden"></span>
          <div style="flex:1"></div>
          <button class="btn btn-ghost btn-sm" onclick="bulkExportCSV()">Export CSV</button>
          <button class="btn btn-ghost btn-sm" onclick="openBulkTagModal()">Add Tag</button>
          <button class="btn btn-ghost btn-sm" onclick="openBulkStatusModal()">Change Status</button>
          <button class="btn btn-ghost btn-sm" onclick="openBulkTypeModal()">Change Type</button>
          <button class="btn btn-danger btn-sm" onclick="bulkArchive()">Archive Selected</button>
          <button class="btn btn-ghost btn-sm" onclick="clearSelection()">Clear</button>
        </div>
        <div class="toolbar">
          <div class="search-box"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input id="c-search" type="text" placeholder="Search contacts..." oninput="onCSearch(this.value)"></div>'''

if old3 in content:
    content = content.replace(old3, new3, 1)
    print('PATCH 3: Bulk bar HTML added to contacts panel.')
else:
    print('WARN: PATCH 3 pattern not found.')

# -------------------------------------------------------
# PATCH 4: Add View Archive button to contacts page header
# -------------------------------------------------------
old4 = '''          <button class="btn btn-primary" onclick="openContactModal()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" xmlns="http://www.w3.org/2000/svg"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add Contact
          </button>'''

new4 = '''          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost" id="archive-toggle-btn" onclick="toggleArchiveView()">View Archive</button>
            <button class="btn btn-primary" id="add-contact-btn" onclick="openContactModal()">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" xmlns="http://www.w3.org/2000/svg"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add Contact
            </button>
          </div>'''

if old4 in content:
    content = content.replace(old4, new4, 1)
    print('PATCH 4: View Archive button added.')
else:
    print('WARN: PATCH 4 pattern not found.')

# -------------------------------------------------------
# PATCH 5: Add checkbox to contacts table header
# -------------------------------------------------------
old5 = "if(thead)thead.innerHTML='<tr>'+th('Name','name')+th('Business','company')+'<th>Phone</th><th>Email</th><th>Tags</th>'+th('Type','type')+'<th>Status</th><th style=\"width:50px\"></th></tr>';"
new5 = "if(thead)thead.innerHTML='<tr><th class=\"cb-col\"><input type=\"checkbox\" id=\"ct-select-all\" onclick=\"toggleSelectAll(event)\" title=\"Select all on page\"></th>'+th('Name','name')+th('Business','company')+'<th>Phone</th><th>Email</th><th>Tags</th>'+th('Type','type')+'<th>Status</th><th style=\"width:50px\"></th></tr>';"

if old5 in content:
    content = content.replace(old5, new5, 1)
    print('PATCH 5: Checkbox added to contacts header.')
else:
    print('WARN: PATCH 5 pattern not found.')

# -------------------------------------------------------
# PATCH 6: Add checkbox to each contacts table row
# -------------------------------------------------------
old6 = "tbody.innerHTML=slice.map(c=>{\n    const col_=avColor(c.name),tags=(c.tags||[]).slice(0,3).map(tid=>{const t=getTag(tid);return t?'<span class=\"tag-pill\" style=\"background:'+t.color+'20;color:'+t.color+';border:1px solid '+t.color+'40\">'+esc(t.name)+'</span>':''}).join('');\n    return'<tr onclick=\"openDrawer(\\''+c.id+'\\')\">'+'<td><div class=\"ct-name-cell\">"
new6 = "tbody.innerHTML=slice.map(c=>{\n    const col_=avColor(c.name),tags=(c.tags||[]).slice(0,3).map(tid=>{const t=getTag(tid);return t?'<span class=\"tag-pill\" style=\"background:'+t.color+'20;color:'+t.color+';border:1px solid '+t.color+'40\">'+esc(t.name)+'</span>':''}).join('');\n    return'<tr onclick=\"openDrawer(\\''+c.id+'\\'\">'+'<td class=\"cb-col\" onclick=\"event.stopPropagation()\"><input type=\"checkbox\" id=\"cb-'+c.id+'\" '+(state.cSelected.has(c.id)?'checked':'')+' onclick=\"toggleSelectContact(\\''+c.id+'\\',event)\"></td>'+'<td><div class=\"ct-name-cell\">"

if old6 in content:
    content = content.replace(old6, new6, 1)
    print('PATCH 6: Checkbox added to each contact row.')
else:
    print('WARN: PATCH 6 pattern not found.')

# -------------------------------------------------------
# PATCH 7: Fix empty state colspan from 8 to 9
# -------------------------------------------------------
old7 = "tbody.innerHTML='<tr><td colspan=\"8\">"
new7 = "tbody.innerHTML='<tr><td colspan=\"9\">"

if old7 in content:
    content = content.replace(old7, new7, 1)
    print('PATCH 7: Empty state colspan fixed.')
else:
    print('WARN: PATCH 7 pattern not found.')

# -------------------------------------------------------
# PATCH 8: Add updateBulkBar and header cb update at end of renderContacts
# -------------------------------------------------------
old8 = "  renderPg('contacts-pg',state.cPage,pages,'cPg');\n}\n\nfunction sortC"
new8 = "  renderPg('contacts-pg',state.cPage,pages,'cPg');\n  updateBulkBar();\n  const hcb=document.getElementById('ct-select-all');\n  if(hcb){const sl=slice.filter(c=>state.cSelected.has(c.id));hcb.checked=slice.length>0&&sl.length===slice.length;hcb.indeterminate=sl.length>0&&sl.length<slice.length;}\n}\n\nfunction sortC"

if old8 in content:
    content = content.replace(old8, new8, 1)
    print('PATCH 8: updateBulkBar wired into renderContacts.')
else:
    print('WARN: PATCH 8 pattern not found.')

# -------------------------------------------------------
# PATCH 9: Filter archived contacts in filteredContacts
# -------------------------------------------------------
old9 = "function filteredContacts(){"
new9 = "function filteredContacts(){\n  if(!state.cShowArchived&&db.contacts.some(c=>c.archived)){return _filteredContacts().filter(c=>!c.archived)}\n  return _filteredContacts();\n}\nfunction _filteredContacts(){"

if old9 in content:
    content = content.replace(old9, new9, 1)
    print('PATCH 9: Archive filter added to filteredContacts.')
else:
    print('WARN: PATCH 9 pattern not found.')

# -------------------------------------------------------
# PATCH 10: Add all bulk action JS before closing </script>
# -------------------------------------------------------
new_js = '''
// =====================================================
// BULK CONTACT SELECTION
// =====================================================
function toggleSelectContact(id,e){
  e.stopPropagation();
  if(state.cSelected.has(id))state.cSelected.delete(id);
  else state.cSelected.add(id);
  const cb=document.getElementById('cb-'+id);
  if(cb)cb.checked=state.cSelected.has(id);
  const filtered=filteredContacts();
  const slice=filtered.slice((state.cPage-1)*PER_PAGE,state.cPage*PER_PAGE);
  const hcb=document.getElementById('ct-select-all');
  if(hcb){const sl=slice.filter(c=>state.cSelected.has(c.id));hcb.checked=slice.length>0&&sl.length===slice.length;hcb.indeterminate=sl.length>0&&sl.length<slice.length;}
  updateBulkBar();
}

function toggleSelectAll(e){
  const filtered=filteredContacts();
  const slice=filtered.slice((state.cPage-1)*PER_PAGE,state.cPage*PER_PAGE);
  const allSelected=slice.every(c=>state.cSelected.has(c.id));
  slice.forEach(c=>allSelected?state.cSelected.delete(c.id):state.cSelected.add(c.id));
  updateBulkBar();
  renderContacts();
}

function selectAllContacts(){
  const filtered=filteredContacts();
  filtered.forEach(c=>state.cSelected.add(c.id));
  updateBulkBar();
  renderContacts();
}

function clearSelection(){
  state.cSelected.clear();
  updateBulkBar();
  renderContacts();
}

function updateBulkBar(){
  const bar=document.getElementById('bulk-bar');
  const countEl=document.getElementById('bulk-count');
  const wrap=document.getElementById('bulk-select-all-wrap');
  if(!bar)return;
  const n=state.cSelected.size;
  if(n>0){
    bar.classList.remove('hidden');
    if(countEl)countEl.textContent=n+' contact'+(n===1?'':'s')+' selected';
    const filtered=filteredContacts();
    const slice=filtered.slice((state.cPage-1)*PER_PAGE,state.cPage*PER_PAGE);
    const allPageSel=slice.every(c=>state.cSelected.has(c.id));
    if(wrap){
      if(allPageSel&&n<filtered.length){
        wrap.classList.remove('hidden');
        wrap.innerHTML='<button class="bulk-select-all-btn" onclick="selectAllContacts()">Select all '+filtered.length+' contacts</button>';
      }else{
        wrap.classList.add('hidden');
      }
    }
  }else{
    bar.classList.add('hidden');
    if(wrap)wrap.classList.add('hidden');
  }
}

function toggleArchiveView(){
  state.cShowArchived=!state.cShowArchived;
  state.cSelected.clear();
  state.cPage=1;
  const btn=document.getElementById('archive-toggle-btn');
  const addBtn=document.getElementById('add-contact-btn');
  if(btn)btn.textContent=state.cShowArchived?'Back to Contacts':'View Archive';
  if(btn)btn.style.color=state.cShowArchived?'var(--orange)':'';
  if(addBtn)addBtn.classList.toggle('hidden',state.cShowArchived);
  renderContacts();
}

// =====================================================
// BULK ACTIONS
// =====================================================
function bulkArchive(){
  const n=state.cSelected.size;
  if(!n)return;
  const action=state.cShowArchived?'restore':'archive';
  state.modal={type:'bulk-archive'};
  document.getElementById('modal-title').textContent=state.cShowArchived?'Restore Contacts':'Archive Contacts';
  document.getElementById('modal-box').className='modal';
  document.getElementById('modal-body').innerHTML=
    '<div class="warn-box">You are about to '+action+' <strong>'+n+' contact'+(n===1?'':'s')+'</strong>.'+(action==='archive'?' They can be restored from the archive later.':'')+'</div>';
  document.getElementById('modal-foot').innerHTML=
    '<button class="btn btn-ghost" onclick="closeModal()">Cancel</button>'+
    '<button class="btn btn-danger" onclick="confirmBulkArchive(\''+action+'\')">'+( action==='archive'?'Archive':'Restore')+' '+n+' Contact'+(n===1?'':'s')+'</button>';
  document.getElementById('modal-overlay').classList.add('open');
}

function confirmBulkArchive(action){
  const ids=[...state.cSelected];
  ids.forEach(function(id){
    const c=getContact(id);
    if(c)c.archived=action==='archive';
  });
  saveData();
  state.cSelected.clear();
  closeModal();
  renderContacts();
  toast(ids.length+' contact'+(ids.length===1?'':'s')+' '+(action==='archive'?'archived':'restored')+'.','success');
}

function openBulkTypeModal(){
  const n=state.cSelected.size;
  document.getElementById('modal-title').textContent='Change Type for '+n+' Contact'+(n===1?'':'s');
  document.getElementById('modal-box').className='modal';
  document.getElementById('modal-body').innerHTML=
    '<div class="form-group"><label>New Type</label><select id="bulk-type-sel" class="filter-sel" style="width:100%;height:38px"><option value="lead">Lead</option><option value="client">Client</option><option value="partner">Partner</option><option value="employee">Employee</option></select></div>';
  document.getElementById('modal-foot').innerHTML=
    '<button class="btn btn-ghost" onclick="closeModal()">Cancel</button>'+
    '<button class="btn btn-purple" onclick="bulkChangeType(document.getElementById(\'bulk-type-sel\').value)">Apply</button>';
  document.getElementById('modal-overlay').classList.add('open');
}

function bulkChangeType(type){
  [...state.cSelected].forEach(function(id){const c=getContact(id);if(c)c.type=type;});
  saveData();closeModal();state.cSelected.clear();renderContacts();
  toast('Contact types updated.','success');
}

function openBulkStatusModal(){
  const n=state.cSelected.size;
  document.getElementById('modal-title').textContent='Change Status for '+n+' Contact'+(n===1?'':'s');
  document.getElementById('modal-box').className='modal';
  document.getElementById('modal-body').innerHTML=
    '<div class="form-group"><label>New Status</label><select id="bulk-status-sel" class="filter-sel" style="width:100%;height:38px"><option value="active">Active</option><option value="inactive">Inactive</option></select></div>';
  document.getElementById('modal-foot').innerHTML=
    '<button class="btn btn-ghost" onclick="closeModal()">Cancel</button>'+
    '<button class="btn btn-purple" onclick="bulkChangeStatus(document.getElementById(\'bulk-status-sel\').value)">Apply</button>';
  document.getElementById('modal-overlay').classList.add('open');
}

function bulkChangeStatus(status){
  [...state.cSelected].forEach(function(id){const c=getContact(id);if(c)c.status=status;});
  saveData();closeModal();state.cSelected.clear();renderContacts();
  toast('Contact statuses updated.','success');
}

function openBulkTagModal(){
  const n=state.cSelected.size;
  const tagOpts=db.tags.map(function(t){return'<option value="'+t.id+'">'+esc(t.name)+'</option>'}).join('');
  document.getElementById('modal-title').textContent='Add Tag to '+n+' Contact'+(n===1?'':'s');
  document.getElementById('modal-box').className='modal';
  document.getElementById('modal-body').innerHTML=
    '<div class="form-group"><label>Tag to Add</label><select id="bulk-tag-sel" class="filter-sel" style="width:100%;height:38px">'+tagOpts+'</select></div>';
  document.getElementById('modal-foot').innerHTML=
    '<button class="btn btn-ghost" onclick="closeModal()">Cancel</button>'+
    '<button class="btn btn-purple" onclick="bulkAddTag(document.getElementById(\'bulk-tag-sel\').value)">Add Tag</button>';
  document.getElementById('modal-overlay').classList.add('open');
}

function bulkAddTag(tagId){
  [...state.cSelected].forEach(function(id){
    const c=getContact(id);
    if(c){if(!c.tags)c.tags=[];if(!c.tags.includes(tagId))c.tags.push(tagId);}
  });
  saveData();closeModal();state.cSelected.clear();renderContacts();
  toast('Tag added to selected contacts.','success');
}

function bulkExportCSV(){
  const contacts=[...state.cSelected].map(function(id){return getContact(id)}).filter(Boolean);
  if(!contacts.length){toast('No contacts selected.','error');return}
  const headers=['Name','Email','Phone','Company','Type','Status','Tags'];
  const rows=contacts.map(function(c){
    return[
      c.name||'',c.email||'',c.phone||'',c.company||'',c.type||'',c.status||'',
      (c.tags||[]).map(function(tid){const t=getTag(tid);return t?t.name:''}).filter(Boolean).join('; ')
    ];
  });
  const csv=[headers,...rows].map(function(r){return r.map(function(v){return'"'+String(v).replace(/"/g,'""')+'"'}).join(',')}).join('\\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download='contacts-export.csv';a.click();
  URL.revokeObjectURL(url);
  toast(contacts.length+' contacts exported.','success');
}
'''

last_idx = content.rfind('</script>')
if last_idx != -1:
    content = content[:last_idx] + new_js + '\n' + content[last_idx:]
    print('PATCH 10: Bulk action JS functions added.')
else:
    print('ERROR: Could not find closing </script>.')

# -------------------------------------------------------
# Write output
# -------------------------------------------------------
if len(content) == original_len:
    print('\nWARN: File unchanged.')
else:
    with open(TARGET, 'w', encoding='utf-8') as f:
        f.write(content)
    print('\nDone. index.html patched successfully.')
