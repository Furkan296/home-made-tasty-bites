/* Browser-safe publishable key only. Access permissions are enforced by SQL policies. */
const SHOP_URL='https://hgaatkotnirazfxwwauu.supabase.co';
const SHOP_KEY='sb_publishable_MIdQp1nPJbexQTmlrHrgCw_8haAD8Q2';
const SHOP_ADMIN='2199f32b-7679-4405-8d4b-18f6aa65b72c';
let shopReady=false,shopSession=null,sharedOrders=[],shopBusy=false,menuRefreshing=false;
try{shopSession=JSON.parse(sessionStorage.getItem('hmtb_admin_session')||'null')}catch(e){}
const htmlSafe=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function saveSession(session){shopSession=session;if(session)sessionStorage.setItem('hmtb_admin_session',JSON.stringify(session));else sessionStorage.removeItem('hmtb_admin_session')}
async function shopFetch(path,{method='GET',body,admin=false}={}){
 if(admin){if(!shopSession)throw Error('Please sign in.');if(Date.now()>=shopSession.expires_at*1000-60000){let session=await shopFetch('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:{refresh_token:shopSession.refresh_token}});saveSession({...session,expires_at:Math.floor(Date.now()/1000)+session.expires_in});}}
 const headers={apikey:SHOP_KEY,'Content-Type':'application/json'};if(admin)headers.Authorization='Bearer '+shopSession.access_token;
 const response=await fetch(SHOP_URL+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const text=await response.text();let data;try{data=text?JSON.parse(text):null}catch(e){throw Error('Could not connect to the shop. Please retry.')}
 if(!response.ok){if(admin&&(response.status===401||response.status===403)){saveSession(null);resetAdmin();}throw Error(data?.message||data?.msg||data?.error_description||'Request failed. Please retry.')}
 return data;
}
function shopNotice(message){document.getElementById('shopConnection').textContent=message;}
const baseRenderProducts=renderProducts;
renderProducts=function(){baseRenderProducts();document.querySelectorAll('#products .product').forEach((node,i)=>{let products=menu.filter(x=>!x.isVariant&&(selected==='All'||x.category===selected));let p=products[i];if(!p)return;let button=node.querySelector('.add');if(button&&(!shopReady||p.available===false)){button.disabled=true;button.textContent=p.available===false?'Out of stock':'Connecting…';}if(p.available===false)node.classList.add('out-of-stock')})};
const originalExtrasFor=extrasFor;
extrasFor=function(p){let base=menu.find(x=>x.id===(p.baseId||p.id));return base?.serverExtras||originalExtrasFor(p)};
const originalAddToCart=addToCart;
addToCart=function(id){let p=menu.find(x=>x.id===id),base=menu.find(x=>x.id===(p?.baseId||id));if(!shopReady){alert('The menu is connecting. Please wait and try again.');return}if(!base||base.available===false){alert('This item is out of stock.');return}originalAddToCart(id)};
const originalConfirmExtras=confirmExtras;
confirmExtras=function(){let p=menu.find(x=>x.id===extrasProductId);if(!shopReady||p?.available===false){alert('This item is currently unavailable.');return}originalConfirmExtras()};
async function refreshSharedMenu(){
 if(menuRefreshing)return;menuRefreshing=true;
 try{
  const rows=await shopFetch('/rest/v1/hmtb_menu?select=*&order=sort_order.asc');if(!Array.isArray(rows)||!rows.length)throw Error('Menu setup is incomplete.');
  let changed=false;for(const p of menu.filter(x=>!x.isVariant)){const row=rows.find(x=>x.id===p.id);if(!row){p.available=false;continue}if(p.price!==row.price||p.available!==row.available)changed=true;p.price=row.price;p.available=row.available;p.serverExtras=row.extras;}
  for(const p of menu.filter(x=>x.isVariant)){let base=menu.find(x=>x.id===p.baseId);p.available=base?.available;p.basePrice=base?.price;p.price=p.basePrice+p.extras.reduce((n,e)=>n+e.price,0)}
  if(changed&&!shopBusy&&pendingOrder){pendingOrder=null;if(document.getElementById('reviewModal').classList.contains('open')){closeModal('reviewModal');document.getElementById('cartModal').classList.add('open');alert('Prices or availability changed. Please review your cart again.');}}shopReady=true;shopNotice('Menu availability and prices updated. Delivery charges are separate.');renderProducts();updateCart();if(document.getElementById('pulpyPromoModal').classList.contains('open'))renderPulpyPromo();
 }catch(e){shopReady=false;shopNotice('Ordering is temporarily unavailable. Please retry or contact the shop on 9620711053.');renderProducts();}
 finally{menuRefreshing=false;}
}
const originalRenderPulpy=renderPulpyPromo;
renderPulpyPromo=function(){originalRenderPulpy();const products=pulpyProducts();document.querySelectorAll('#pulpyPromoProducts .pulpy-card').forEach((node,i)=>{let p=products[i];if(p&&(!shopReady||p.available===false)){let button=node.querySelector('button');if(button){button.disabled=true;button.textContent=p.available===false?'Out of stock':'Connecting…'}}})};
const originalPlaceOrder=placeOrder;
placeOrder=function(){if(!shopReady){alert('Please wait for the menu to connect.');return}if(menu.some(x=>cart[x.id]&&x.available===false)){alert('An item in your cart is out of stock. Remove it before continuing.');return}originalPlaceOrder();if(pendingOrder&&!pendingOrder.requestId){pendingOrder.requestId=crypto.randomUUID();pendingOrder.id='Assigned when you send the order';document.getElementById('orderPreview').textContent=formatOrder(pendingOrder);}};
sendOrderToWhatsApp=async function(){
 if(!pendingOrder||shopBusy)return;const order=pendingOrder;shopBusy=true;const button=document.getElementById('sendWhatsAppButton');button.disabled=true;button.textContent='Saving your order…';
 try{
  const lines=menu.filter(p=>cart[p.id]).map(p=>({id:p.baseId||p.id,qty:cart[p.id],extras:(p.extras||[]).map(e=>e.key)}));
  const result=await shopFetch('/rest/v1/rpc/hmtb_place_order',{method:'POST',body:{p_request_id:order.requestId,p_name:order.name,p_phone:order.phone,p_address:order.address,p_map:order.map||'',p_payment:order.payment,p_items:lines,p_expected_total:order.total}});
  Object.assign(order,result);pendingOrder=order;document.getElementById('orderPreview').textContent=formatOrder(order);
  window.location.href='https://wa.me/91'+ADMIN_PHONE+'?text='+encodeURIComponent(formatOrder(order));
 }catch(e){alert('Order could not be saved: '+e.message);await refreshSharedMenu();}
 finally{shopBusy=false;button.disabled=false;button.textContent=order.payment==='UPIQR'?'Open WhatsApp & attach payment screenshot':'Send order via WhatsApp';}
};
function resetAdmin(){sharedOrders=[];document.getElementById('adminLogin').classList.remove('hidden');document.getElementById('adminPanel').classList.add('hidden');document.getElementById('adminOrders').replaceChildren();document.getElementById('adminMenu').replaceChildren();}
function assertAdmin(){if(shopSession?.user?.id!==SHOP_ADMIN)throw Error('This account does not have shop admin access.')}
openAdminLogin=function(){document.getElementById('adminModal').classList.add('open');if(shopSession?.user?.id===SHOP_ADMIN){document.getElementById('adminLogin').classList.add('hidden');document.getElementById('adminPanel').classList.remove('hidden');renderAdminOrders();}else resetAdmin()};
adminLogin=async function(){let button=document.getElementById('adminSignIn');button.disabled=true;document.getElementById('adminError').textContent='Signing in…';try{
 let data=await shopFetch('/auth/v1/token?grant_type=password',{method:'POST',body:{email:document.getElementById('adminEmail').value.trim(),password:document.getElementById('adminPass').value}});
 if(data.user?.id!==SHOP_ADMIN)throw Error('This account does not have shop admin access.');saveSession({...data,expires_at:Math.floor(Date.now()/1000)+data.expires_in});document.getElementById('adminPass').value='';document.getElementById('adminError').textContent='';openAdminLogin();
 }catch(e){document.getElementById('adminError').textContent=e.message}finally{button.disabled=false}};
async function adminLogout(){try{if(shopSession)await shopFetch('/auth/v1/logout',{method:'POST',admin:true})}catch(e){}saveSession(null);resetAdmin();}
renderAdminOrders=async function(){try{assertAdmin();let rows=await shopFetch('/rest/v1/hmtb_orders?select=*&order=created_at.desc&limit=200',{admin:true});sharedOrders=rows;
 const statuses=['Awaiting WhatsApp confirmation','Received','Preparing','Ready','Out for delivery','Delivered','Cancelled'];
 document.getElementById('adminOrders').innerHTML='<p class="muted">Latest 200 orders · Refreshes every 15 seconds. Confirm the WhatsApp message before preparing. UPI payment must be checked separately.</p>'+rows.map(o=>`<div class="panel" style="margin:10px 0"><b>${htmlSafe(o.id)}</b> · ${htmlSafe(new Date(o.created_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}))}<p><strong>${htmlSafe(o.name)}</strong> · ${htmlSafe(o.phone)}</p><p>${o.items.map(i=>htmlSafe(i.name)+' × '+i.qty+' × '+money(i.price)).join('<br>')}</p><strong>Food total: ${money(o.total)}</strong><p>${htmlSafe(o.address)}<br>${htmlSafe(o.map)}<br>Payment: ${htmlSafe(o.payment)} — verify separately</p><div class="two"><select id="status-${htmlSafe(o.id)}">${statuses.map(x=>`<option ${o.status===x?'selected':''}>${x}</option>`).join('')}</select><button class="soft" onclick="updateStatus('${htmlSafe(o.id)}')">Save status</button></div><a target="_blank" rel="noopener" href="https://wa.me/91${encodeURIComponent(o.phone)}?text=${encodeURIComponent('Hello '+o.name+', order '+o.id+' is '+o.status+'.')}">Open WhatsApp update</a></div>`).join('')+(rows.length?'':'<p>No shared orders yet.</p>');
 }catch(e){document.getElementById('adminOrders').textContent='Unable to load orders: '+e.message}};
updateStatus=async function(id){try{assertAdmin();await shopFetch('/rest/v1/hmtb_orders?id=eq.'+encodeURIComponent(id),{method:'PATCH',admin:true,body:{status:document.getElementById('status-'+id).value}});await renderAdminOrders()}catch(e){alert(e.message)}};
renderAdminMenu=function(){document.getElementById('adminMenu').innerHTML='<p class="muted">Save each item to update its price and availability for customers. Changes appear within 15 seconds.</p>'+menu.filter(p=>!p.isVariant).map(p=>`<div class="adminrow"><div><b>${htmlSafe(p.name)}</b><div>${htmlSafe(p.category)}</div></div><div><label>Price ₹ <input id="price-${p.id}" type="number" min="0" max="100000" step="1" value="${p.price}" style="width:85px"></label><label style="display:block"><input id="stock-${p.id}" type="checkbox" ${p.available!==false?'checked':''}> Available</label><button class="soft" onclick="saveMenuItem(${p.id},this)">Save</button></div></div>`).join('')};
async function saveMenuItem(id,button){button.disabled=true;try{assertAdmin();let price=Number(document.getElementById('price-'+id).value);if(!Number.isInteger(price)||price<0||price>100000)throw Error('Enter a valid whole-rupee price.');await shopFetch('/rest/v1/hmtb_menu?id=eq.'+id,{method:'PATCH',admin:true,body:{price,available:document.getElementById('stock-'+id).checked}});await refreshSharedMenu();button.textContent='Saved';}catch(e){alert(e.message)}finally{button.disabled=false}}
function openAdminFromHash(){if(location.hash==='#admin')openAdminLogin()}
window.addEventListener('hashchange',openAdminFromHash);openAdminFromHash();renderProducts();refreshSharedMenu();
setInterval(()=>{if(!document.hidden){refreshSharedMenu();if(shopSession&&document.getElementById('adminModal').classList.contains('open')&&!document.getElementById('adminOrders').classList.contains('hidden')&&!document.getElementById('adminOrders').contains(document.activeElement))renderAdminOrders();}},15000);
