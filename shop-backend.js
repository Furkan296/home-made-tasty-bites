let statsOrders=[],statsLoaded=false,statsBusy=false,statsRun=0;
/* Browser-safe publishable key only. Access permissions are enforced by SQL policies. */
const SHOP_URL='https://hgaatkotnirazfxwwauu.supabase.co';
const SHOP_KEY='sb_publishable_MIdQp1nPJbexQTmlrHrgCw_8haAD8Q2';
const SHOP_ADMIN='2199f32b-7679-4405-8d4b-18f6aa65b72c';
let openingAuto=true,openingOverrideUntil=null;
let restaurantOpen=false,restaurantSaving=false,rushMode=false,rushSaving=false,rushAuto=true;
let shopReady=false,shopSession=null,sharedOrders=[],shopBusy=false,menuRefreshing=false;
try{shopSession=JSON.parse(sessionStorage.getItem('hmtb_admin_session')||'null')}catch(e){}
const htmlSafe=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function saveSession(session){shopSession=session;if(session)sessionStorage.setItem('hmtb_admin_session',JSON.stringify(session));else sessionStorage.removeItem('hmtb_admin_session')}
async function shopFetch(path,{method='GET',body,admin=false,returnRows=false}={}){
 if(admin){if(!shopSession)throw Error('Please sign in.');if(Date.now()>=shopSession.expires_at*1000-60000){let session=await shopFetch('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:{refresh_token:shopSession.refresh_token}});saveSession({...session,expires_at:Math.floor(Date.now()/1000)+session.expires_in});}}
 const headers={apikey:SHOP_KEY,'Content-Type':'application/json'};if(returnRows)headers.Prefer='return=representation';if(admin)headers.Authorization='Bearer '+shopSession.access_token;
 const response=await fetch(SHOP_URL+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const text=await response.text();let data;try{data=text?JSON.parse(text):null}catch(e){throw Error('Could not connect to the shop. Please retry.')}
 if(!response.ok){if(admin&&(response.status===401||response.status===403)){saveSession(null);resetAdmin();}throw Error(data?.message||data?.msg||data?.error_description||'Request failed. Please retry.')}
 return data;
}
function shopNotice(message){document.getElementById('shopConnection').textContent=message;}
const baseRenderProducts=renderProducts;
renderProducts=function(){baseRenderProducts();document.querySelectorAll('#products .product').forEach((node,i)=>{let products=menu.filter(x=>!x.isVariant&&(selected==='All'||(selected==='Recommended'?productTags(x).length>0:x.category===selected)));let p=products[i];if(!p)return;let button=node.querySelector('.add');if(button&&(!shopReady||!restaurantOpen||p.available===false)){button.disabled=true;button.textContent=!shopReady?'Connecting…':!restaurantOpen?'Restaurant closed':'Out of stock';}if(p.available===false)node.classList.add('out-of-stock')})};
const originalExtrasFor=extrasFor;
extrasFor=function(p){let base=menu.find(x=>x.id===(p.baseId||p.id));return base?.serverExtras||originalExtrasFor(p)};
const originalAddToCart=addToCart;
addToCart=function(id){let p=menu.find(x=>x.id===id),base=menu.find(x=>x.id===(p?.baseId||id));if(!shopReady){alert('The menu is connecting. Please wait and try again.');return}if(!restaurantOpen){alert('The restaurant is closed. Please order when we reopen.');return}if(!base||base.available===false){alert('This item is out of stock.');return}originalAddToCart(id)};
const originalConfirmExtras=confirmExtras;
confirmExtras=function(){let p=menu.find(x=>x.id===extrasProductId);if(!shopReady||!restaurantOpen||p?.available===false){alert('This item is currently unavailable.');return}originalConfirmExtras()};
async function refreshSharedMenu(){
 if(menuRefreshing)return;menuRefreshing=true;
 try{
  const [rows,settings]=await Promise.all([shopFetch('/rest/v1/hmtb_menu?select=*&order=sort_order.asc'),shopFetch('/rest/v1/hmtb_restaurant_status?id=eq.1&select=is_open,rush_mode,rush_auto,hours_auto,hours_override_until')]);if(!Array.isArray(settings)||settings.length!==1||typeof settings[0].is_open!=='boolean'||typeof settings[0].rush_mode!=='boolean')throw Error('Restaurant status setup is incomplete.');restaurantOpen=settings[0].is_open;rushMode=restaurantOpen&&settings[0].rush_mode;rushAuto=settings[0].rush_auto===true;openingAuto=settings[0].hours_auto===true;openingOverrideUntil=settings[0].hours_override_until;if(!Array.isArray(rows)||!rows.length)throw Error('Menu setup is incomplete.');
  let changed=false;for(const p of menu.filter(x=>!x.isVariant)){const row=rows.find(x=>x.id===p.id);if(!row){p.available=false;continue}if(p.price!==row.price||p.available!==row.available)changed=true;p.price=row.price;p.available=row.available;p.serverExtras=row.extras;}
  for(const p of menu.filter(x=>x.isVariant)){let base=menu.find(x=>x.id===p.baseId);p.available=base?.available;p.basePrice=base?.price;p.price=p.basePrice+p.extras.reduce((n,e)=>n+e.price,0)}
  if(changed&&!shopBusy&&pendingOrder){pendingOrder=null;if(document.getElementById('reviewModal').classList.contains('open')){closeModal('reviewModal');document.getElementById('cartModal').classList.add('open');alert('Prices or availability changed. Please review your cart again.');}}shopReady=true;syncRestaurantStatus();shopNotice(restaurantOpen?'Menu availability and prices updated. Delivery charges are separate.':'The restaurant is closed. You can browse the menu; new orders are paused.');renderProducts();updateCart();if(document.getElementById('pulpyPromoModal').classList.contains('open'))renderPulpyPromo();
 }catch(e){shopReady=false;syncRestaurantStatus();shopNotice('Ordering is temporarily unavailable. Please retry or contact the shop on 9620711053.');renderProducts();}
 finally{menuRefreshing=false;}
}
const originalRenderPulpy=renderPulpyPromo;
renderPulpyPromo=function(){originalRenderPulpy();const products=pulpyProducts();document.querySelectorAll('#pulpyPromoProducts .pulpy-card').forEach((node,i)=>{let p=products[i];if(p&&(!shopReady||!restaurantOpen||p.available===false)){let button=node.querySelector('button');if(button){button.disabled=true;button.textContent=!shopReady?'Connecting…':!restaurantOpen?'Restaurant closed':'Out of stock'}}})};
const originalPlaceOrder=placeOrder;
placeOrder=function(){if(!restaurantOpen){alert('The restaurant is closed. Please order when we reopen.');return}if(!shopReady){alert('Please wait for the menu to connect.');return}if(menu.some(x=>cart[x.id]&&x.available===false)){alert('An item in your cart is out of stock. Remove it before continuing.');return}originalPlaceOrder();if(pendingOrder&&!pendingOrder.requestId){pendingOrder.requestId=crypto.randomUUID();pendingOrder.id='Assigned when you send the order';document.getElementById('orderPreview').textContent=formatOrder(pendingOrder);}};
sendOrderToWhatsApp=async function(){
 if(!pendingOrder||shopBusy)return;if(!shopReady||!restaurantOpen){alert('The restaurant is not accepting orders right now.');return}const order=pendingOrder;shopBusy=true;const button=document.getElementById('sendWhatsAppButton');button.disabled=true;button.textContent='Saving your order…';
 try{
  const lines=menu.filter(p=>cart[p.id]).map(p=>({id:p.baseId||p.id,qty:cart[p.id],extras:(p.extras||[]).map(e=>e.key)}));
  const result=await shopFetch('/rest/v1/rpc/hmtb_place_order_with_notes',{method:'POST',body:{p_request_id:order.requestId,p_name:order.name,p_phone:order.phone,p_address:order.address,p_map:order.map||'',p_payment:order.payment,p_items:lines,p_expected_total:order.total,p_instructions:order.instructions||''}});
  Object.assign(order,result);pendingOrder=order;document.getElementById('orderPreview').textContent=formatOrder(order);
  window.location.href='https://wa.me/91'+ADMIN_PHONE+'?text='+encodeURIComponent(formatOrder(order));
 }catch(e){alert('Order could not be saved: '+e.message);await refreshSharedMenu();}
 finally{shopBusy=false;button.disabled=!shopReady||!restaurantOpen;button.textContent=order.payment==='UPIQR'?'Open WhatsApp & attach payment screenshot':'Send order via WhatsApp';}
};

let orderSoundContext=null,orderSoundEnabled=false,orderSoundTimer=null,orderSoundNodes=[],orderSeenIds=null,orderAlertPolling=false;
function stopOrderSound(){clearTimeout(orderSoundTimer);orderSoundTimer=null;for(const node of orderSoundNodes){try{node.stop()}catch(e){}}orderSoundNodes=[];}
function playOrderSound(){
 if(!orderSoundEnabled||!orderSoundContext)return;
 if(orderSoundContext.state!=='running'){document.getElementById('orderSoundStatus').textContent='Sound paused by browser. Click Enable sound again.';return}
 stopOrderSound();const start=orderSoundContext.currentTime;
 for(let offset=0;offset<15;offset+=1){for(const beat of [0,0.28]){const osc=orderSoundContext.createOscillator(),gain=orderSoundContext.createGain(),at=start+offset+beat;osc.type='sine';osc.frequency.value=beat?880:660;gain.gain.setValueAtTime(0,at);gain.gain.linearRampToValueAtTime(0.22,at+0.015);gain.gain.setValueAtTime(0.22,at+0.18);gain.gain.linearRampToValueAtTime(0,at+0.24);osc.connect(gain);gain.connect(orderSoundContext.destination);osc.start(at);osc.stop(at+0.25);osc.onended=()=>{osc.disconnect();gain.disconnect()};orderSoundNodes.push(osc)}}
 orderSoundTimer=setTimeout(stopOrderSound,15000);
}
function checkNewOrderRows(rows){const ids=rows.map(row=>row.id);const fresh=orderSeenIds===null?[]:rows.filter(row=>!orderSeenIds.has(row.id));if(orderSeenIds===null)orderSeenIds=new Set();ids.forEach(id=>orderSeenIds.add(id));if(fresh.length&&orderSoundEnabled){document.getElementById('orderSoundStatus').textContent='New order: '+fresh.map(row=>row.id).join(', ')+'. Confirm it in WhatsApp.';playOrderSound()}}
async function enableOrderSound(){try{assertAdmin();const AudioEngine=window.AudioContext||window.webkitAudioContext;if(!AudioEngine)throw Error('This browser does not support sound alerts.');if(!orderSoundContext)orderSoundContext=new AudioEngine();await orderSoundContext.resume();if(orderSoundContext.state!=='running')throw Error('Browser sound is paused. Please try again.');if(orderSeenIds===null){const rows=await shopFetch('/rest/v1/hmtb_orders?select=id&order=created_at.desc&limit=200',{admin:true});checkNewOrderRows(rows)}orderSoundEnabled=true;document.getElementById('orderSoundStatus').textContent='Sound enabled. New orders ring for 15 seconds. Keep this admin page open.';}catch(e){document.getElementById('orderSoundStatus').textContent=e.message}}
function disableOrderSound(){orderSoundEnabled=false;stopOrderSound();document.getElementById('orderSoundStatus').textContent='Sound off. Click Enable sound to receive alerts.'}
async function pollOrderAlerts(){if(!orderSoundEnabled||orderAlertPolling||shopSession?.user?.id!==SHOP_ADMIN)return;orderAlertPolling=true;try{checkNewOrderRows(await shopFetch('/rest/v1/hmtb_orders?select=id&order=created_at.desc&limit=200',{admin:true}))}catch(e){document.getElementById('orderSoundStatus').textContent='Cannot check new orders: '+e.message}finally{orderAlertPolling=false}}
setInterval(pollOrderAlerts,5000);

function resetAdmin(){statsRun++;statsBusy=false;statsOrders=[];statsLoaded=false;document.getElementById('statsResults').replaceChildren();document.getElementById('statsMessage').textContent='';disableOrderSound();orderSeenIds=null;sharedOrders=[];document.getElementById('adminLogin').classList.remove('hidden');document.getElementById('adminPanel').classList.add('hidden');document.getElementById('adminOrders').replaceChildren();document.getElementById('adminMenu').replaceChildren();}
function assertAdmin(){if(shopSession?.user?.id!==SHOP_ADMIN)throw Error('This account does not have shop admin access.')}
openAdminLogin=function(){document.getElementById('adminModal').classList.add('open');if(shopSession?.user?.id===SHOP_ADMIN){document.getElementById('adminLogin').classList.add('hidden');document.getElementById('adminPanel').classList.remove('hidden');syncRestaurantStatus();renderAdminOrders();}else resetAdmin()};
adminLogin=async function(){let button=document.getElementById('adminSignIn');button.disabled=true;document.getElementById('adminError').textContent='Signing in…';try{
 let data=await shopFetch('/auth/v1/token?grant_type=password',{method:'POST',body:{email:document.getElementById('adminEmail').value.trim(),password:document.getElementById('adminPass').value}});
 if(data.user?.id!==SHOP_ADMIN)throw Error('This account does not have shop admin access.');saveSession({...data,expires_at:Math.floor(Date.now()/1000)+data.expires_in});document.getElementById('adminPass').value='';document.getElementById('adminError').textContent='';openAdminLogin();
 }catch(e){document.getElementById('adminError').textContent=e.message}finally{button.disabled=false}};
async function adminLogout(){try{if(shopSession)await shopFetch('/auth/v1/logout',{method:'POST',admin:true})}catch(e){}saveSession(null);resetAdmin();}
renderAdminOrders=async function(){try{assertAdmin();let rows=await shopFetch('/rest/v1/hmtb_orders?select=*&order=created_at.desc&limit=200',{admin:true});sharedOrders=rows;checkNewOrderRows(rows);
 const statuses=['Awaiting WhatsApp confirmation','Received','Preparing','Ready','Out for delivery','Delivered','Cancelled'];
 document.getElementById('adminOrders').innerHTML='<p class="muted">Latest 200 orders · Refreshes every 15 seconds. Confirm the WhatsApp message before preparing. UPI payment must be checked separately.</p>'+rows.map(o=>`<div class="panel" style="margin:10px 0"><b>${htmlSafe(o.id)}</b> · ${htmlSafe(new Date(o.created_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}))}<p><strong>${htmlSafe(o.name)}</strong> · ${htmlSafe(o.phone)}</p><p>${o.items.map(i=>htmlSafe(i.name)+' × '+i.qty+' × '+money(i.price)).join('<br>')}</p>${o.instructions?`<p><strong>Special instructions:</strong><br>${htmlSafe(o.instructions).replace(/\n/g,'<br>')}</p>`:''}<strong>Food total: ${money(o.total)}</strong><p>${htmlSafe(o.address)}<br>${htmlSafe(o.map)}<br>Payment: ${htmlSafe(o.payment)} — verify separately</p><div class="two"><select id="status-${htmlSafe(o.id)}">${statuses.map(x=>`<option ${o.status===x?'selected':''}>${x}</option>`).join('')}</select><button class="soft" onclick="updateStatus('${htmlSafe(o.id)}')">Save status</button></div><a target="_blank" rel="noopener" href="https://wa.me/91${encodeURIComponent(o.phone)}?text=${encodeURIComponent('Hello '+o.name+', order '+o.id+' is '+o.status+'.')}">Open WhatsApp update</a></div>`).join('')+(rows.length?'':'<p>No shared orders yet.</p>');
 }catch(e){document.getElementById('adminOrders').textContent='Unable to load orders: '+e.message}};
updateStatus=async function(id){try{assertAdmin();await shopFetch('/rest/v1/hmtb_orders?id=eq.'+encodeURIComponent(id),{method:'PATCH',admin:true,body:{status:document.getElementById('status-'+id).value}});await renderAdminOrders()}catch(e){alert(e.message)}};
let adminMenuSearch='',adminStockFilter='all';
function filterAdminMenu(){
 const input=document.getElementById('adminMenuSearch');
 adminMenuSearch=input.value;
 const terms=adminMenuSearch.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
 let count=0;
 document.querySelectorAll('#adminMenu .adminrow').forEach(row=>{const match=(adminStockFilter==='all'||row.dataset.available==='false')&&terms.every(term=>row.dataset.search.includes(term));row.hidden=!match;if(match)count++});
 document.getElementById('adminMenuCount').textContent=count ? count+' products found' : (adminStockFilter==='out'?'No out-of-stock items match this search.':'No products found. Try another name or category.');
 const outCount=menu.filter(p=>!p.isVariant&&p.available===false).length;document.getElementById('adminOutStockTab').textContent='Out of stock ('+outCount+')';for(const [id,active] of [['adminAllStockTab',adminStockFilter==='all'],['adminOutStockTab',adminStockFilter==='out']]){document.getElementById(id).classList.toggle('active',active);document.getElementById(id).setAttribute('aria-pressed',String(active))}
}
function selectAdminStockFilter(value){adminStockFilter=value;document.getElementById('adminMenuSearch').value='';filterAdminMenu()}
function syncAdminStockRow(id,available){const row=document.getElementById('stock-'+id)?.closest('.adminrow');if(row){row.dataset.available=String(available);document.getElementById('stock-'+id).checked=available;row.querySelector('.restore-stock').hidden=available}filterAdminMenu()}
async function restoreStockItem(id,button){button.disabled=true;try{assertAdmin();await shopFetch('/rest/v1/hmtb_menu?id=eq.'+id,{method:'PATCH',admin:true,body:{available:true}});const item=menu.find(p=>p.id===id);if(item)item.available=true;syncAdminStockRow(id,true);await refreshSharedMenu()}catch(e){alert(e.message)}finally{button.disabled=false}}
function clearAdminMenuSearch(){document.getElementById('adminMenuSearch').value='';filterAdminMenu();document.getElementById('adminMenuSearch').focus()}
renderAdminMenu=function(){document.getElementById('adminMenu').innerHTML='<p class="muted">Save each item to update its price and availability for customers. Changes appear within 15 seconds.</p><div class="tabs"><button id="adminAllStockTab" class="outline tab" type="button" onclick="selectAdminStockFilter(\'all\')">All items</button><button id="adminOutStockTab" class="outline tab" type="button" onclick="selectAdminStockFilter(\'out\')">Out of stock</button></div><label for="adminMenuSearch"><strong>Search products</strong></label><div style="display:flex;gap:8px;margin:8px 0"><input id="adminMenuSearch" type="search" placeholder="Search name or category, e.g. chicken pizza" style="flex:1;min-width:0" oninput="filterAdminMenu()"><button type="button" class="outline" onclick="clearAdminMenuSearch()">Clear</button></div><p id="adminMenuCount" class="muted" role="status" aria-live="polite"></p>'+menu.filter(p=>!p.isVariant).map(p=>`<div class="adminrow" data-available="${p.available!==false}" data-search="${htmlSafe((p.name+' '+p.category).toLocaleLowerCase())}"><div><b>${htmlSafe(p.name)}</b><div>${htmlSafe(p.category)}</div></div><div><label>Price ₹ <input id="price-${p.id}" type="number" min="0" max="100000" step="1" value="${p.price}" style="width:85px"></label><label style="display:block"><input id="stock-${p.id}" type="checkbox" ${p.available!==false?'checked':''}> Available</label><button class="soft" onclick="saveMenuItem(${p.id},this)">Save</button> <button class="primary restore-stock" ${p.available!==false?'hidden':''} onclick="restoreStockItem(${p.id},this)">Mark available</button></div></div>`).join('');document.getElementById('adminMenuSearch').value=adminMenuSearch;filterAdminMenu()};
async function saveMenuItem(id,button){button.disabled=true;try{assertAdmin();let price=Number(document.getElementById('price-'+id).value);if(!Number.isInteger(price)||price<0||price>100000)throw Error('Enter a valid whole-rupee price.');await shopFetch('/rest/v1/hmtb_menu?id=eq.'+id,{method:'PATCH',admin:true,body:{price,available:document.getElementById('stock-'+id).checked}});const available=document.getElementById('stock-'+id).checked;const item=menu.find(p=>p.id===id);if(item)item.available=available;syncAdminStockRow(id,available);await refreshSharedMenu();button.textContent='Saved';}catch(e){alert(e.message)}finally{button.disabled=false}}
function openAdminFromHash(){if(location.hash==='#admin')openAdminLogin()}
window.addEventListener('hashchange',openAdminFromHash);openAdminFromHash();renderProducts();refreshSharedMenu();
setInterval(()=>{if(!document.hidden){refreshSharedMenu();if(shopSession&&document.getElementById('adminModal').classList.contains('open')&&!document.getElementById('adminOrders').classList.contains('hidden')&&!document.getElementById('adminOrders').contains(document.activeElement))renderAdminOrders();}},15000);

function syncRestaurantStatus(){
 const text=!shopReady?'Checking restaurant availability…':restaurantOpen?'OPEN — accepting orders':'CLOSED — not accepting orders right now';
 const banner=document.getElementById('restaurantStatus');banner.dataset.state=!shopReady?'checking':restaurantOpen?'open':'closed';banner.innerHTML='<span class="status-dot" aria-hidden="true"></span><div><strong>'+(!shopReady?'CHECKING AVAILABILITY':restaurantOpen?'OPEN NOW · LET’S EAT!':'CLOSED · BACK SOON')+'</strong><span>'+(!shopReady?'Connecting to our kitchen. Please wait a moment.':restaurantOpen?'Fresh food, made with love. We’re accepting your orders.':'Mon–Sat: 4 PM–3 AM next morning. Sunday: 4 PM–11 PM. We look forward to serving you.')+'</span></div>';
 document.getElementById('adminRestaurantStatus').textContent=text;syncOpeningHoursMode();
 const button=document.getElementById('restaurantToggle');button.disabled=!shopReady||restaurantSaving;button.setAttribute('aria-checked',String(restaurantOpen&&shopReady));button.textContent=restaurantSaving?'Saving…':!shopReady?'Unavailable':restaurantOpen?'Close temporarily':'Open temporarily';
 if(!shopBusy)document.getElementById('sendWhatsAppButton').disabled=!shopReady||!restaurantOpen;
 syncRushMode();
}
async function setRestaurantOpen(value){
 if(restaurantSaving)return;restaurantSaving=true;syncRestaurantStatus();
 try{assertAdmin();const rows=await shopFetch('/rest/v1/hmtb_settings?id=eq.1',{method:'PATCH',admin:true,body:{is_open:!!value,hours_auto:false},returnRows:true});if(!Array.isArray(rows)||rows.length!==1)throw Error('Restaurant status was not saved. Please sign in again.');await loadRushStatus();shopReady=true;renderProducts();if(document.getElementById('pulpyPromoModal').classList.contains('open'))renderPulpyPromo();shopNotice(restaurantOpen?'Restaurant is open. Customers can place orders.':'Restaurant is closed. New orders are paused.');}
 catch(e){alert('Could not change restaurant status: '+e.message);}
 finally{restaurantSaving=false;syncRestaurantStatus();}
}
const originalGoCheckout=goCheckout;
goCheckout=function(){if(!shopReady||!restaurantOpen){alert('The restaurant is not accepting orders right now.');return}originalGoCheckout()};

function syncRushMode(){
 const usable=shopReady&&restaurantOpen;
 document.getElementById('rushNotice').hidden=!(usable&&rushMode);
 document.getElementById('adminRushControls').classList.toggle('hidden',!usable);
 document.getElementById('adminRushStatus').textContent=(rushAuto?'AUTOMATIC SCHEDULE · ':'MANUAL OVERRIDE · ')+(rushMode?'Rush Mode is ON':'Rush Mode is OFF');
 const button=document.getElementById('rushToggle');button.disabled=!usable||rushSaving||restaurantSaving;button.setAttribute('aria-checked',String(usable&&rushMode));button.textContent=rushSaving?'Saving…':rushMode?'Turn OFF manually':'Turn ON manually';
 const auto=document.getElementById('rushAutoButton');if(auto){auto.disabled=!usable||rushSaving||restaurantSaving||rushAuto;auto.textContent=rushAuto?'✓ Automatic schedule active':'Use automatic schedule';}
}
async function setRushMode(value){
 if(rushSaving||restaurantSaving)return;if(!shopReady||!restaurantOpen){alert('Rush Mode is available only while the restaurant is open.');return;}
 rushSaving=true;syncRushMode();
 try{assertAdmin();const rows=await shopFetch('/rest/v1/hmtb_settings?id=eq.1',{method:'PATCH',admin:true,body:{rush_mode:!!value,rush_auto:false},returnRows:true});if(!Array.isArray(rows)||rows.length!==1)throw Error('Rush Mode was not saved. Please sign in again.');await loadRushStatus();syncRestaurantStatus();renderProducts();}
 catch(e){alert('Could not change Rush Mode: '+e.message);}
 finally{rushSaving=false;syncRushMode();}
}

async function loadRushStatus(){
 const rows=await shopFetch('/rest/v1/hmtb_restaurant_status?id=eq.1&select=is_open,rush_mode,rush_auto,hours_auto,hours_override_until');
 if(!Array.isArray(rows)||rows.length!==1||typeof rows[0].is_open!=='boolean'||typeof rows[0].rush_mode!=='boolean'||typeof rows[0].rush_auto!=='boolean')throw Error('Could not read restaurant schedule. Please refresh.');
 restaurantOpen=rows[0].is_open;rushMode=restaurantOpen&&rows[0].rush_mode;rushAuto=rows[0].rush_auto;openingAuto=rows[0].hours_auto===true;openingOverrideUntil=rows[0].hours_override_until;
}
async function useAutomaticRush(){
 if(rushSaving||restaurantSaving||!shopReady||!restaurantOpen)return;
 rushSaving=true;syncRushMode();
 try{assertAdmin();const rows=await shopFetch('/rest/v1/hmtb_settings?id=eq.1',{method:'PATCH',admin:true,body:{rush_auto:true},returnRows:true});if(!Array.isArray(rows)||rows.length!==1)throw Error('Automatic schedule was not saved.');await loadRushStatus();syncRestaurantStatus();}
 catch(e){alert('Could not enable automatic Rush Mode: '+e.message);}
 finally{rushSaving=false;syncRushMode();}
}

// One explicit formatter for the final WhatsApp handoff, including older cached inline code.
formatOrder=function(o){let payment={COD:'COD',UPIQR:'UPI QR — awaiting shop confirmation'}[o.payment]||o.payment;return ['Order No: '+o.id,'','*Name: '+o.name+'*','*Phone: '+o.phone+'*','','Items:',...o.items.map((i,n)=>(n+1)+'. '+i.name+' 👉 *QTY: '+i.qty+'* 👈 '+money(i.price)+' each = '+money(i.qty*i.price)),...(o.instructions?['','*Special instructions:* '+o.instructions]:[]),'','*Food total: '+money(o.total)+'*','','Payment: '+payment,...(o.payment==='UPIQR'?['Payment screenshot: Please attach in this WhatsApp chat.']:[]),'','*_Delivery: '+o.address+'_*','Map: '+(o.map||'Not shared')].join('\n')};

function syncOpeningHoursMode(){
 const label=document.getElementById('openingHoursMode'),button=document.getElementById('hoursAutoButton');
 if(label)label.textContent=!shopReady?'Checking opening schedule…':openingAuto?'AUTOMATIC OPENING HOURS · The restaurant opens and closes on schedule.':'TEMPORARY MANUAL OVERRIDE · Automatic resumes at '+new Date(openingOverrideUntil).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour:'numeric',minute:'2-digit',day:'numeric',month:'short'})+' IST.';
 if(button){button.disabled=!shopReady||restaurantSaving||openingAuto;button.textContent=openingAuto?'✓ Automatic opening hours active':'Resume automatic opening hours';}
}
async function useAutomaticOpeningHours(){
 if(restaurantSaving)return;restaurantSaving=true;syncRestaurantStatus();
 try{assertAdmin();const rows=await shopFetch('/rest/v1/hmtb_settings?id=eq.1',{method:'PATCH',admin:true,body:{hours_auto:true},returnRows:true});if(!Array.isArray(rows)||rows.length!==1)throw Error('Opening schedule was not saved.');await loadRushStatus();renderProducts();if(document.getElementById('pulpyPromoModal').classList.contains('open'))renderPulpyPromo();}
 catch(e){alert('Could not resume automatic opening hours: '+e.message);}
 finally{restaurantSaving=false;syncRestaurantStatus();}
}

// Private statistics: fetched with the signed-in admin token, independently of the 200-order list.

const statsDate=d=>d.toISOString().slice(0,10);
function statsLocal(order){const local=new Date(new Date(order.created_at).getTime()+19800000),hour=local.getUTCHours();const date=new Date(local);if(hour<4)date.setUTCDate(date.getUTCDate()-1);return {day:statsDate(date),hour,session:hour>=16&&hour<23?'day':hour>=23||hour<4?'night':'other'};}
function statsToday(){return statsLocal({created_at:new Date().toISOString()}).day}
function statsShift(day,n){const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return statsDate(d)}
function statsRange(kind,today=statsToday()){const d=new Date(today+'T00:00:00Z'),y=d.getUTCFullYear(),m=d.getUTCMonth();let start=today,end=today;
 if(kind==='yesterday')start=end=statsShift(today,-1);
 if(kind==='week')start=statsShift(today,-6);
 if(kind==='month')start=statsDate(new Date(Date.UTC(y,m,1)));
 if(kind==='quarter'){const q=Math.floor(m/3)*3;start=statsDate(new Date(Date.UTC(y,q-3,1)));end=statsDate(new Date(Date.UTC(y,q,0)))}
 if(kind==='year'){start=(y-1)+'-01-01';end=(y-1)+'-12-31'}
 if(kind==='ytd')start=y+'-01-01';
 if(kind==='all')start='';
 return {start,end};}
function statsPresetChanged(){const kind=document.getElementById('statsPeriod').value;if(kind!=='custom'){const r=statsRange(kind);document.getElementById('statsStart').value=r.start;document.getElementById('statsEnd').value=r.end}renderStatistics()}
async function loadStatistics(){if(statsBusy)return;assertAdmin();statsBusy=true;const run=++statsRun;document.getElementById('statsMessage').textContent='Loading full order history…';try{let rows=[],offset=0;for(;;){const page=await shopFetch('/rest/v1/hmtb_orders?select=id,created_at,status,total,items,payment&order=created_at.asc,id.asc&limit=500&offset='+offset,{admin:true});if(run!==statsRun||shopSession?.user?.id!==SHOP_ADMIN)return;rows.push(...page);if(page.length<500)break;offset+=page.length}statsOrders=Array.from(new Map(rows.map(o=>[o.id,o])).values());statsLoaded=true;document.getElementById('statsMessage').textContent='Updated '+new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})+' IST · '+statsOrders.length+' saved orders loaded.';renderStatistics()}catch(e){if(run===statsRun){document.getElementById('statsMessage').textContent='Unable to load statistics: '+e.message;document.getElementById('statsResults').replaceChildren()}}finally{if(run===statsRun)statsBusy=false}}
function openStatistics(){if(!document.getElementById('statsEnd').value){const r=statsRange('week');document.getElementById('statsStart').value=r.start;document.getElementById('statsEnd').value=r.end}if(!statsLoaded)loadStatistics();else renderStatistics()}
function statsAggregate(orders){const result={orders:orders.length,total:0,units:0,products:new Map(),days:new Map(),weekdays:Array.from({length:7},()=>({orders:0,total:0,units:0,products:new Map()})),sessions:new Map()};
 for(const o of orders){const local=statsLocal(o),weekday=new Date(local.day+'T00:00:00Z').getUTCDay();const day=result.days.get(local.day)||{orders:0,total:0,units:0};const session=result.sessions.get(local.session)||{orders:0,total:0};const amount=Number(o.total)||0;result.total+=amount;day.orders++;day.total+=amount;session.orders++;session.total+=amount;const wd=result.weekdays[weekday];wd.orders++;wd.total+=amount;
 for(const i of o.items||[]){const qty=Number(i.qty)||0,price=Number(i.price)||0,name=String(i.name||'Unnamed item').split(' [Add-ons:')[0];result.units+=qty;day.units+=qty;wd.units+=qty;wd.products.set(name,(wd.products.get(name)||0)+qty);const product=result.products.get(name)||{name,units:0,total:0,orders:0};product.units+=qty;product.total+=qty*price;result.products.set(name,product)}
 for(const name of new Set((o.items||[]).map(i=>String(i.name||'Unnamed item').split(' [Add-ons:')[0])))result.products.get(name).orders++;
 result.days.set(local.day,day);result.sessions.set(local.session,session)}return result;}
function statsTable(headers,rows){return '<div class="stats-table-wrap"><table class="stats-table"><thead><tr>'+headers.map(x=>'<th>'+htmlSafe(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(cell=>'<td>'+htmlSafe(cell)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>'}
function renderStatistics(){if(!statsLoaded)return;const start=document.getElementById('statsStart').value,end=document.getElementById('statsEnd').value,session=document.getElementById('statsSession').value,status=document.getElementById('statsStatus').value;const target=document.getElementById('statsResults');if(start&&end&&start>end){target.textContent='Start date must be on or before end date.';return}
 const period=statsOrders.filter(o=>{const l=statsLocal(o);return (!start||l.day>=start)&&(!end||l.day<=end)&&(session==='all'||session===l.session)});
 const included=period.filter(o=>status==='all'||(status==='confirmed'?!['Cancelled','Awaiting WhatsApp confirmation'].includes(o.status):o.status===status));const a=statsAggregate(included);const products=[...a.products.values()].sort((x,y)=>y.units-x.units||y.total-x.total||x.name.localeCompare(y.name));const max=products[0]?.units||1;
 const cards=[['Orders',a.orders],['Food order value',money(a.total)],['Item quantities',a.units],['Average order value',money(a.orders?a.total/a.orders:0)],['Awaiting confirmation',period.filter(o=>o.status==='Awaiting WhatsApp confirmation').length],['Cancelled',period.filter(o=>o.status==='Cancelled').length]];
 target.innerHTML='<div class="stats-cards">'+cards.map(([label,value])=>'<div class="stats-card"><span>'+htmlSafe(label)+'</span><strong>'+htmlSafe(value)+'</strong></div>').join('')+'</div>'+(included.length?'':'<p class="notice">No matching orders. Try a wider period or a different status filter.</p>')+'<h3>Best-selling items</h3><div class="stats-bars">'+products.slice(0,10).map(p=>'<div><div>'+htmlSafe(p.name)+' <strong>'+p.units+'</strong></div><div class="stats-track"><span style="width:'+Math.round(p.units/max*100)+'%"></span></div></div>').join('')+'</div><h3>All item totals</h3>'+statsTable(['Item','Quantity','Orders containing item','Food value'],products.map(p=>[p.name,p.units,p.orders,money(p.total)]))+'<h3>Daily totals</h3>'+statsTable(['Kitchen date','Orders','Quantity','Food value'],[...a.days].sort((x,y)=>y[0].localeCompare(x[0])).map(([day,v])=>[day,v.orders,v.units,money(v.total)]))+'<h3>Which days sell what?</h3>'+statsTable(['Weekday','Orders','Quantity','Food value','Top item'],['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((name,i)=>{const w=a.weekdays[i],top=[...w.products].sort((x,y)=>y[1]-x[1])[0];return [name,w.orders,w.units,money(w.total),top?top[0]+' ('+top[1]+')':'—']}))+'<h3>Day and night comparison</h3>'+statsTable(['Session','Orders','Food value'],[...a.sessions].map(([name,v])=>[name==='day'?'Day · 4 PM–11 PM':name==='night'?'Night · 11 PM–4 AM':'Outside session',v.orders,money(v.total)]))+'<h3>Payment method selected</h3>'+statsTable(['Method','Orders','Food value'],['UPIQR','COD'].map(method=>{const orders=included.filter(o=>o.payment===method);return [method==='UPIQR'?'UPI QR':'COD',orders.length,money(orders.reduce((sum,o)=>sum+(Number(o.total)||0),0))]}));
}

let reviewDraft='',reviewSubmitBusy=false,reviewOffset=0,reviewLoading=false;
function reviewShareText(name,rating,text){return rating+'/5 stars\n'+text+'\n— '+name;}
async function loadCustomerReviews(reset=true){if(reviewLoading)return;reviewLoading=true;const list=document.getElementById('customerReviewsList');try{if(reset)reviewOffset=0;const rows=await shopFetch('/rest/v1/hmtb_reviews?select=id,name,rating,feedback,created_at&order=created_at.desc,id.desc&limit=20&offset='+reviewOffset);if(reset)list.replaceChildren();for(const r of rows){const article=document.createElement('article');article.className='review-card';const name=document.createElement('strong');name.textContent=r.name;const stars=document.createElement('div');stars.textContent='★'.repeat(r.rating)+'☆'.repeat(5-r.rating)+' · '+new Date(r.created_at).toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata'});const body=document.createElement('p');body.textContent=r.feedback;article.append(name,stars,body);list.append(article)}reviewOffset+=rows.length;document.getElementById('reviewsMore').hidden=rows.length<20;if(!reviewOffset)list.textContent='Be the first to share your experience.';if(reset){const summary=await shopFetch('/rest/v1/rpc/hmtb_reviews_summary',{method:'POST',body:{}});document.getElementById('reviewsSummary').textContent=summary.count?summary.average+' / 5 · '+summary.count+' customer reviews':'No ratings yet.'}}catch(e){document.getElementById('reviewsSummary').textContent='Reviews could not load. Please try again.'}finally{reviewLoading=false}}
async function submitCustomerReview(event){event.preventDefault();if(reviewSubmitBusy)return;const form=event.target;if(!form.reportValidity())return;const name=form.elements.reviewName.value.trim(),rating=Number(form.elements.reviewRating.value),feedback=form.elements.reviewText.value.trim();if(name.length<2||feedback.length<3){document.getElementById('reviewSubmitStatus').textContent='Please enter your name and at least 3 characters of feedback.';return}reviewSubmitBusy=true;const button=document.getElementById('reviewSubmitButton');button.disabled=true;document.getElementById('reviewSubmitStatus').textContent='Publishing your review…';try{await shopFetch('/rest/v1/rpc/hmtb_submit_review',{method:'POST',body:{p_name:name,p_rating:rating,p_feedback:feedback}});reviewDraft=reviewShareText(name,rating,feedback);document.getElementById('reviewCopyText').value=reviewDraft;document.getElementById('reviewSharePanel').hidden=false;document.getElementById('reviewSubmitStatus').textContent='Thank you! Your review is published on our website.';form.reset();await loadCustomerReviews(true)}catch(e){document.getElementById('reviewSubmitStatus').textContent='Could not publish: '+e.message}finally{reviewSubmitBusy=false;button.disabled=false}}
async function copyCustomerReview(){const field=document.getElementById('reviewCopyText');try{await navigator.clipboard.writeText(field.value);document.getElementById('reviewCopyStatus').textContent='Copied. Open Google Maps, choose Write a review, select your stars, paste the text and tap Post.'}catch(e){field.focus();field.select();document.getElementById('reviewCopyStatus').textContent='Select and copy the text below, then paste it into your Google Maps review.'}}
function shareReviewWhatsApp(){window.open('https://wa.me/91'+ADMIN_PHONE+'?text='+encodeURIComponent('Customer feedback for Home Made Tasty Bites\n\n'+document.getElementById('reviewCopyText').value),'_blank','noopener')}
loadCustomerReviews(true);
