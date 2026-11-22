'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  user: null, seller: null, categories: [], products: [], config: { shipping_kobo: 200000, commission_bps: 500, delivery_pricing_mode: 'zone', payments_enabled: false },
  category: 'all', filter: 'all', query: '', sort: 'featured', cart: readCart(), wishlist: new Set(),
  authMode: 'login', dashboardTab: 'overview', sellerData: null, adminData: {}, currentProduct: null, toastTimer: null,
  unreadNotifications: 0, notificationTimer: null, notificationTopId: null, promoPreview: null
};
const money = kobo => '₦' + (Number(kobo || 0) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
const nairaToKobo = value => Math.max(0, Math.round(Number(value || 0) * 100));
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const textStatus = value => String(value || '').replaceAll('_',' ');
const escAttr = value => html(value).replace(/`/g, '&#96;');
const GROWTH_STORAGE_KEY = 'ethan-market-growth-attribution-v1';
function readGrowthAttribution() {
  try { return JSON.parse(localStorage.getItem(GROWTH_STORAGE_KEY)||'{}')||{}; } catch { return {}; }
}
function captureGrowthAttribution() {
  const params=new URLSearchParams(location.search);
  const current=readGrowthAttribution();
  const next={...current};
  if(!next.ref && params.get('ref')) next.ref=String(params.get('ref')).trim().toUpperCase().slice(0,40);
  if(!next.campaign && params.get('utm_campaign')) next.campaign=String(params.get('utm_campaign')).trim().toLowerCase().slice(0,100);
  if(!next.source && params.get('utm_source')) next.source=String(params.get('utm_source')).trim().slice(0,80);
  if(!next.medium && params.get('utm_medium')) next.medium=String(params.get('utm_medium')).trim().slice(0,80);
  try { localStorage.setItem(GROWTH_STORAGE_KEY,JSON.stringify(next)); } catch {}
  return next;
}
function growthPayload() {
  const item=readGrowthAttribution();
  return {referral_code:item.ref||'',campaign_slug:item.campaign||'',utm_source:item.source||'',utm_medium:item.medium||''};
}
async function trackGrowthEvent(eventType) {
  const data=readGrowthAttribution();
  try { await api('growth.track',{event_type:eventType,campaign_slug:data.campaign||'',source:data.source||'',medium:data.medium||'',referral_code:data.ref||'',path:location.pathname}); } catch {}
}

function readCart() {
  try { const raw = JSON.parse(localStorage.getItem('ethan-market-cart-v1') || '[]'); return Array.isArray(raw) ? raw.filter(x => x && typeof x.product_id === 'string' && Number(x.quantity) > 0) : []; }
  catch { return []; }
}
function saveCart() { try { localStorage.setItem('ethan-market-cart-v1', JSON.stringify(state.cart)); } catch {} }
function notify(message, kind = '') {
  const node = $('#toast'); if (!node) return;
  node.textContent = message; node.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => node.className = 'toast', 2600);
}
async function api(action, payload = {}) {
  let response;
  try {
    response = await fetch('/api/market', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ action, ...payload })
    });
  } catch { throw new Error('Could not reach ETHAN MARKET. Check your internet connection and try again.'); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'The marketplace could not complete that request.');
  return body.data;
}
function showModal(id) { const modal = $('#' + id); if (!modal) return; modal.hidden = false; document.body.classList.add('modal-open'); }
function closeModal(id) { const modal = $('#' + id); if (!modal) return; modal.hidden = true; if (!$$('.modal-backdrop').some(m => !m.hidden)) document.body.classList.remove('modal-open'); }
function openAuth(mode = 'login', message = '') {
  setAuthMode(mode); $('#auth-error').textContent = message; showModal('auth-modal');
}
function updateOwnerTokenVisibility() {
  const isOwner = $('#auth-email').value.trim().toLowerCase() === 'abayomipeteroyenuga@gmail.com';
  const visible = state.authMode === 'register' && isOwner;
  $('#owner-token-wrap').hidden = !visible;
  $('#owner-token').required = visible;
}
function setAuthMode(mode) {
  state.authMode = mode;
  if(mode==='register') trackGrowthEvent('signup_view');
  $$('.auth-tab').forEach(b => b.classList.toggle('active', b.dataset.authMode === mode));
  const registering = mode === 'register';
  $('#auth-name-wrap').hidden = !registering;
  $('#auth-name').required = registering;
  $('#auth-phone-wrap').hidden = !registering;
  $('#auth-password-confirm-wrap').hidden = !registering;
  $('#auth-password-confirm').required = registering;
  updateOwnerTokenVisibility();
  $('#auth-title').textContent = mode === 'login' ? 'Good to see you.' : 'Create your account.';
  $('#auth-intro').textContent = mode === 'login' ? 'Sign in to manage your orders, wishlist and store.' : 'Create one account to shop, save items and apply to open a store.';
  $('#auth-submit').innerHTML = mode === 'login' ? 'Sign in <span>→</span>' : 'Create account <span>→</span>';
  $('#auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#auth-error').textContent = '';
}
function cartProducts(){return state.cart.map(item=>{const product=state.products.find(p=>p.id===item.product_id);const variants=Array.isArray(product?.variants)?product.variants:[];const variant=variants.find(v=>v.id===item.variant_id);return {...item,product,variant,unit_price_kobo:variant?Number(variant.price_kobo):Number(product?.price_kobo||0)};}).filter(item=>item.product&&(!item.product.variants?.length||item.variant));}
function cartCount(){return state.cart.reduce((sum,item)=>sum+Number(item.quantity||0),0);}
function cartSubtotal(){return cartProducts().reduce((sum,item)=>sum+item.unit_price_kobo*item.quantity,0);}
function hasPhysical() { return cartProducts().some(x => x.product.product_type === 'physical'); }
function cartShipping() { return hasPhysical() ? Number(state.config.shipping_kobo || 200000) : 0; }
function cartTotal() { return cartSubtotal() + cartShipping(); }
function updateCartCount() { $('#cart-count').textContent = cartCount(); $('#drawer-count').textContent = `(${cartCount()})`; }
function placeholderImage(product) {
  const category = String(product.category_name || product.category || '').toLowerCase();
  const emoji = category.includes('elect') ? '⌁' : category.includes('fashion') ? '◈' : category.includes('home') ? '⌂' : category.includes('beauty') ? '✦' : category.includes('food') ? '◉' : category.includes('digital') ? '▣' : category.includes('book') ? '▤' : '✧';
  return `<div class="product-emoji" aria-hidden="true">${emoji}</div>`;
}
function imageContent(product) {
  const url = String(product.image_url || '');
  if (/^https:\/\//i.test(url)) return `<img loading="lazy" src="${escAttr(url)}" alt="${escAttr(product.name)}" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="product-emoji" hidden>✧</span>`;
  return placeholderImage(product);
}
function renderCategories() {
  const categories = state.categories;
  $('#category-grid').innerHTML = categories.map(c => `<button class="category-card ${state.category === c.slug ? 'selected' : ''}" data-category="${escAttr(c.slug)}"><i>${html(c.icon || '▦')}</i><b>${html(c.name)}</b></button>`).join('');
  $('#product-category').innerHTML = categories.map(c => `<option value="${escAttr(c.id)}">${html(c.name)}</option>`).join('');
}
function visibleProducts() {
  let products = [...state.products];
  if (state.category !== 'all') products = products.filter(p => p.category_slug === state.category);
  if (state.filter === 'physical') products = products.filter(p => p.product_type === 'physical');
  if (state.filter === 'digital') products = products.filter(p => p.product_type === 'digital');
  if (state.filter === 'featured') products = products.filter(p => p.featured);
  if (state.query) {
    const q = state.query.toLowerCase();
    products = products.filter(p => [p.name,p.description,p.store_name,p.category_name].some(v => String(v || '').toLowerCase().includes(q)));
  }
  if (state.sort === 'price-asc') products.sort((a,b) => Number(a.price_kobo)-Number(b.price_kobo));
  if (state.sort === 'price-desc') products.sort((a,b) => Number(b.price_kobo)-Number(a.price_kobo));
  if (state.sort === 'popular') products.sort((a,b) => Number(b.views || 0)-Number(a.views || 0));
  return products;
}
function renderProducts() {
  const list = visibleProducts();
  $('#product-grid').innerHTML = list.map(p => `
    <article class="product-card" data-product="${escAttr(p.id)}">
      <div class="product-image"><span class="product-badge">${p.product_type === 'digital' ? 'DIGITAL PRODUCT' : p.featured ? 'FEATURED FIND' : html(p.category_name || 'MARKET FIND')}</span>
        <button class="wishlist-button ${state.wishlist.has(p.id) ? 'saved' : ''}" data-wish="${escAttr(p.id)}" aria-label="${state.wishlist.has(p.id) ? 'Remove from' : 'Add to'} wishlist">${state.wishlist.has(p.id) ? '♥' : '♡'}</button>${imageContent(p)}</div>
      <div class="product-info"><span class="product-category">${html(p.category_name || 'Marketplace')}</span><h3><a class="product-title-link" href="/product/${encodeURIComponent(p.slug||'item')}/${encodeURIComponent(p.id)}">${html(p.name)}</a></h3><span class="seller-name">Sold by <a class="store-link" href="/store/${encodeURIComponent(p.store_slug||'')}">${html(p.store_name || 'Ethan seller')}</a></span>
        <div class="product-bottom"><strong class="product-price">${money(p.price_kobo)} ${p.compare_at_kobo ? `<s>${money(p.compare_at_kobo)}</s>` : ''}</strong><span class="product-rating">${Number(p.rating || 0) ? `<strong>★</strong> ${Number(p.rating).toFixed(1)}` : 'New'}${Number(p.review_count || 0) ? ` (${p.review_count})` : ''}</span></div>
        <div class="product-card-actions"><button class="add-button" data-add="${escAttr(p.id)}" ${p.product_type==='physical'&&Number(p.stock_qty)<1?'disabled':''}>${p.product_type==='physical'&&Number(p.stock_qty)<1?'Out of stock':p.variants?.length?'Choose options':'Add to bag +'}</button><button class="view-button" data-view="${escAttr(p.id)}">View</button></div>
      </div>
    </article>`).join('');
  $('#results-count').textContent = `${list.length} product${list.length === 1 ? '' : 's'} found`;
  $('#empty-state').hidden = list.length > 0;
  $('#product-grid').hidden = list.length === 0;
}
async function loadProducts() {
  try {
    const result = await api('products.list', { category: state.category === 'all' ? '' : state.category, type: state.filter === 'physical' || state.filter === 'digital' ? state.filter : '', featured: state.filter === 'featured' ? 'true' : '', q: state.query, sort: state.sort, limit: 60 });
    state.products = result.products || [];
    renderProducts();
  } catch (e) {
    state.products = []; renderProducts(); $('#results-count').textContent = 'Products are temporarily unavailable';
    $('#empty-state').querySelector('h3').textContent = 'We’re preparing the market.';
    $('#empty-state').querySelector('p').textContent = e.message;
  }
}
async function initPublicData() {
  try {
    const [categories, config] = await Promise.all([api('categories.list'), api('market.config')]);
    state.categories = categories.categories || [];
    state.config = config || state.config;
    renderCategories();
  } catch (e) { notify(e.message); }
  await loadProducts();
}
function setFilter(filter) {
  state.filter = filter;
  $$('.filter-chip').forEach(b => b.classList.toggle('selected', b.dataset.filter === filter));
  loadProducts();
}
function selectCategory(slug) {
  state.category = slug; state.filter = 'all'; state.query = '';
  $('#search-input').value = '';
  $$('.filter-chip').forEach(b => b.classList.toggle('selected', b.dataset.filter === 'all'));
  renderCategories(); loadProducts(); $('#shop').scrollIntoView({behavior:'smooth'});
}
function openCart() {
  renderCart(); const drawer = $('#cart-drawer'); drawer.classList.add('open'); drawer.setAttribute('aria-hidden','false'); $('#drawer-backdrop').hidden = false; document.body.style.overflow = 'hidden';
}
function closeCart() {
  $('#cart-drawer').classList.remove('open'); $('#cart-drawer').setAttribute('aria-hidden','true'); $('#drawer-backdrop').hidden = true;
  if (!$$('.modal-backdrop').some(m => !m.hidden)) document.body.style.overflow = '';
}
function renderCart() {
  const entries = cartProducts();
  updateCartCount();
  $('#cart-subtotal').textContent = money(cartSubtotal());
  $('#checkout-button').disabled = entries.length === 0;
  $('#cart-items').innerHTML=entries.length?entries.map(({product:p,variant,variant_id,quantity,unit_price_kobo})=>`<div class="cart-line"><div class="cart-thumb">${/^https:\/\//i.test(p.image_url||'')?`<img src="${escAttr(p.image_url)}" alt="">`:'✧'}</div><div><strong>${html(p.name)}</strong><small>${variant?html(variant.name)+' · ':''}${money(unit_price_kobo)} each · ${p.product_type==='digital'?'Digital':'Physical'}</small><div class="quantity-control"><button data-qty="${escAttr(p.id)}" data-variant="${escAttr(variant_id||'')}" data-delta="-1" aria-label="Decrease quantity">−</button><span>${quantity}</span><button data-qty="${escAttr(p.id)}" data-variant="${escAttr(variant_id||'')}" data-delta="1" aria-label="Increase quantity">＋</button></div></div><strong class="cart-line-price">${money(unit_price_kobo*quantity)}</strong></div>`).join('') : `<div class="cart-empty"><span>▢</span><b>Your bag is empty.</b><p>Start exploring and add something you love.</p></div>`;
}
async function addToCart(productId,variantId=''){
 let product=state.products.find(p=>p.id===productId);
 if(!product){try{const result=await api('products.detail',{id:productId});product=result.product;state.products.push(product);}catch(e){notify(e.message||'This product is no longer available.');return;}}
 const variants=Array.isArray(product.variants)?product.variants:[];
 if(variants.length&&!variantId){showProduct(productId);notify('Choose a size, colour or option before adding this product.');return;}
 const variant=variants.find(v=>v.id===variantId&&v.active!==false);
 if(variants.length&&!variant){notify('Please choose an available product variation.');return;}
 const stock=variant?Number(variant.stock_qty):product.product_type==='physical'?Number(product.stock_qty||0):20;
 if(stock<1){notify('This item is currently out of stock.');return;}
 const row=state.cart.find(x=>x.product_id===productId&&(x.variant_id||'')===(variantId||''));
 if(row){if(Number(row.quantity)>=Math.min(stock,20)){notify('You have reached the available stock for this item.');return;}row.quantity++;}
 else state.cart.push({product_id:productId,variant_id:variantId||'',quantity:1});
 saveCart();renderCart();notify('Added to your shopping bag.');
}
async function hydrateCart() {
  const missing = state.cart.map(x => x.product_id).filter(id => !state.products.some(p => p.id === id));
  await Promise.all(missing.map(async id => {
    try { const result = await api('products.detail', { id }); if (result.product) state.products.push(result.product); }
    catch { state.cart = state.cart.filter(x => x.product_id !== id); saveCart(); }
  }));
}
function changeQuantity(productId,delta,variantId=''){const item=state.cart.find(x=>x.product_id===productId&&(x.variant_id||'')===(variantId||''));if(!item)return;item.quantity+=delta;if(item.quantity<=0)state.cart=state.cart.filter(x=>!(x.product_id===productId&&(x.variant_id||'')===(variantId||'')));saveCart();renderCart();}
async function syncWishlist() {
  if (!state.user) return;
  try { const data = await api('wishlist.list'); state.wishlist = new Set((data.products || []).map(p => p.id)); renderProducts(); } catch {}
}
async function toggleWishlist(productId) {
  if (!state.user) { openAuth('login','Sign in to save items to your wishlist.'); return; }
  try { const result = await api('wishlist.toggle',{product_id:productId}); if(result.saved) state.wishlist.add(productId); else state.wishlist.delete(productId); renderProducts(); notify(result.saved ? 'Saved to your wishlist.' : 'Removed from wishlist.'); }
  catch(e) { notify(e.message); }
}
async function showProduct(productId){
 try{
  const data=await api('products.detail',{id:productId}),p=data.product;state.currentProduct=p;
  const variants=Array.isArray(p.variants)?p.variants:[];
  trackGrowthEvent('product_view');
  const variantControl=variants.length?'<div class="form-field variant-picker"><label for="detail-variant">Choose size, colour or option *</label><select id="detail-variant"><option value="">Select an option</option>'+variants.filter(v=>v.active!==false).map(v=>'<option value="'+escAttr(v.id)+'" '+(Number(v.stock_qty)<1?'disabled':'')+'>'+html(v.name)+' — '+money(v.price_kobo)+' ('+Number(v.stock_qty)+' available)</option>').join('')+'</select></div>':'';
  const totalStock=variants.length?variants.reduce((n,v)=>n+Number(v.stock_qty||0),0):Number(p.stock_qty||0);
  $('#detail-content').innerHTML='<div class="detail-layout"><div class="detail-image">'+(/^https:\/\//i.test(p.image_url||'')?'<img src="'+escAttr(p.image_url)+'" alt="'+escAttr(p.name)+'">':'✧')+'</div><div class="detail-copy"><span class="product-category">'+html(p.category_name||'Marketplace')+'</span><h2 id="detail-name">'+html(p.name)+'</h2><div class="detail-store">Sold by <button class="store-link" type="button" data-store="'+escAttr(p.store_slug||'')+'">'+html(p.store_name)+'</button> · '+html([p.city,p.state].filter(Boolean).join(', '))+'</div><div class="detail-price">'+(variants.length?'From ':'')+money(variants.length?Math.min(...variants.map(v=>Number(v.price_kobo))):p.price_kobo)+'</div><div class="detail-meta"><span>'+(p.product_type==='digital'?'Digital delivery':'Physical product')+'</span><span>'+totalStock+' in stock</span></div><p>'+html(p.description)+'</p>'+variantControl+'<div class="detail-actions"><button class="button button-primary" data-detail-add="'+escAttr(p.id)+'" '+(totalStock<1?'disabled':'')+'>'+(variants.length?'Add selected option to bag <span>＋</span>':'Add to bag <span>＋</span>')+'</button><button class="button button-outline" data-wish="'+escAttr(p.id)+'">♡ Save</button></div></div></div>';
  showModal('detail-modal');
 }catch(e){notify(e.message);}
}
async function showStore(slug) {
  if (!slug) return;
  try {
    const data = await api('store.detail', { slug });
    trackGrowthEvent('store_view');
    const store = data.store, products = data.products || [];
    $('#detail-content').innerHTML = `<div class="store-page"><div class="store-page-head"><div class="store-avatar">${html(String(store.store_name||'E').trim().slice(0,1).toUpperCase())}</div><div><span class="eyebrow">ETHAN MARKET SELLER</span><h2 id="detail-name">${html(store.store_name)}</h2><p>${html([store.city,store.state].filter(Boolean).join(', ') || 'Nigeria')} · On ETHAN MARKET since ${formatDate(store.created_at)}</p></div></div><p class="store-page-description">${html(store.description || 'Welcome to our store.')}</p><div class="store-page-products"><div class="section-heading"><div><div class="eyebrow">THE STORE COLLECTION</div><h3>Available products</h3></div><span>${products.length} listed</span></div><div class="store-products-grid">${products.map(p=>`<article class="store-product"><div class="store-product-image">${imageContent(p)}</div><div><small>${html(p.category_name||'Marketplace')}</small><b>${html(p.name)}</b><strong>${money(p.price_kobo)}</strong><button class="dash-action primary" data-view="${escAttr(p.id)}">View product</button></div></article>`).join('') || '<p>No products are currently listed in this store.</p>'}</div></div></div>`;
    showModal('detail-modal');
  } catch (e) { notify(e.message); }
}
function openCheckout() {
  if (!state.cart.length) return;
  if (!state.config.payments_enabled) { notify('Your bag is saved. Secure checkout will open once Paystack is configured.'); return; }
  if (!state.user) { closeCart(); openAuth('login','Sign in or create an account before checkout.'); return; }
  const physical = hasPhysical();
  $('#checkout-address').required = physical; $('#checkout-city').required = physical; $('#checkout-state').required = physical;
  $('#checkout-address').closest('.form-field').querySelector('label').textContent = physical ? 'Street address *' : 'Street address (optional)';
  $('#checkout-city').closest('.form-field').querySelector('label').textContent = physical ? 'City *' : 'City (optional)';
  $('#checkout-state').closest('.form-field').querySelector('label').textContent = physical ? 'State *' : 'State (optional)';
  $('#checkout-recipient').value = state.user.full_name || '';
  $('#checkout-phone').value = state.user.phone || '';
  $('#checkout-total').textContent = money(cartTotal());
  $('#checkout-breakdown').innerHTML='<small>Enter your delivery city and state to calculate the zone fee.</small>';
  $('#checkout-error').textContent = '';
  $('#checkout-promo').value='';
  $('#checkout-promo-feedback').textContent='';
  state.promoPreview=null;
  closeCart(); showModal('checkout-modal');
  previewCheckout();
  trackGrowthEvent('checkout_started');
}
function formatDate(value) { try { return new Intl.DateTimeFormat('en-NG',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(value)); } catch { return value || '—'; } }
function statusPill(value) { const text = textStatus(value); return `<span class="status-pill ${html(value)}">${html(text)}</span>`; }
function tableEmpty(message, columns = 1) { return `<tr><td colspan="${columns}" class="dash-empty">${html(message)}</td></tr>`; }
function openDashboard(tab) {
  if (!state.user) { openAuth('login'); return; }
  const role = state.user.role;
  const tabs = role === 'super_admin' || role === 'admin' ? [
    ['overview','Overview'],['sellers','Sellers'],['products','Products'],['orders','Orders'],['disputes','Disputes'],['payouts','Payouts'],['growth','Growth'],['notifications','Notifications'],['settings','Settings']
  ] : role === 'seller' ? [['overview','Overview'],['products','Products'],['orders','Orders'],['disputes','Disputes'],['payouts','Payouts'],['growth','Grow & refer'],['notifications','Notifications'],['store','Store settings']] : [['orders','My orders'],['wishlist','Wishlist'],['growth','Grow & refer'],['notifications','Notifications'],['sell','Become a seller']];
  state.dashboardTabs = tabs;
  state.dashboardTab = tab || tabs[0][0];
  $('#dashboard-title').textContent = role === 'super_admin' || role === 'admin' ? 'Marketplace control.' : role === 'seller' ? 'Seller studio.' : 'Your account.';
  renderDashboardTabs(); showModal('dashboard-modal'); loadDashboardTab();
}
function updateNotificationBadge() {
  const button=$('#account-button');
  if(button) {
    let dot=button.querySelector('.notification-dot');
    if(!dot) { dot=document.createElement('span'); dot.className='notification-dot'; button.appendChild(dot); }
    dot.hidden=state.unreadNotifications<1;
    dot.textContent=state.unreadNotifications>9?'9+':String(state.unreadNotifications);
    const isAdmin=Boolean(state.user&&['admin','super_admin'].includes(state.user.role));
    const accountLabel=isAdmin?'Open ETHAN MARKET admin dashboard':state.user?'Open your ETHAN MARKET account':'Open your ETHAN MARKET sign-in';
    button.setAttribute('aria-label',state.unreadNotifications?(`${accountLabel}, ${state.unreadNotifications} unread notifications`):accountLabel);
  }
}
function renderDashboardTabs() {
  if(Array.isArray(state.dashboardTabs)) {
    $('#dashboard-tabs').innerHTML = state.dashboardTabs.map(([id,label])=>{const pending=id==='sellers'?Number(state.adminData?.overview?.sellers?.pending||0):0;const caption=id==='sellers'&&pending?`${label} (${pending})`:label;return `<button class="dashboard-tab ${state.dashboardTab===id?'active':''}" data-dash-tab="${id}">${caption}${id==='notifications'&&state.unreadNotifications? ` <span class="notification-count">${state.unreadNotifications>99?'99+':state.unreadNotifications}</span>`:''}</button>`;}).join('');
  }
  updateNotificationBadge();
}
async function loadDashboardTab() {
  renderDashboardTabs();
  const el = $('#dashboard-content'); el.innerHTML = '<div class="dashboard-loading">Loading your workspace…</div>';
  const tab = state.dashboardTab;
  try {
    if(tab==='notifications') {
      const data=await api('notifications.list');
      state.unreadNotifications=Number(data.unread_count||0);
      renderNotifications(data);
      renderDashboardTabs();
      return;
    }
    if (state.user.role === 'super_admin' || state.user.role === 'admin') {
      const data = tab === 'overview' ? await api('admin.overview') : tab === 'settings' ? await api('admin.list',{kind:'settings'}) : await api('admin.list',{kind:tab});
      state.adminData[tab] = data; renderAdminTab(tab,data); renderDashboardTabs(); return;
    }
    if(tab==='growth' && ['buyer','seller'].includes(state.user.role)) {
      const data=await api('growth.dashboard');renderGrowthDashboard(data);return;
    }
    if (state.user.role === 'seller') {
      if (tab === 'store') { const data=await api('seller.dashboard'); state.sellerData=data; renderStoreSettings(); return; }
      const data = await api('seller.dashboard'); state.sellerData = data; renderSellerTab(tab,data); return;
    }
    if (tab === 'orders') { const data=await api('buyer.orders'); renderBuyerOrders(data.orders||[]); return; }
    if (tab === 'wishlist') { const data=await api('wishlist.list'); renderBuyerWishlist(data.products||[]); return; }
    if (tab === 'sell') { el.innerHTML=`<div class="dash-panel"><h3>Open a store on Ethan</h3><p class="modal-intro">Complete a seller application. After approval you can add products, view orders and track payouts.</p><button class="button button-primary" id="dashboard-apply-seller">Apply to become a seller →</button></div>`; return; }
  } catch(e) { el.innerHTML=`<div class="dash-panel"><p class="form-error">${html(e.message)}</p><button class="dash-action" id="dashboard-retry">Try again</button></div>`; }
}
function renderNotifications(data) {
  const el=$('#dashboard-content');
  const items=Array.isArray(data.notifications)?data.notifications:[];
  state.unreadNotifications=Number(data.unread_count||0);
  const content=items.map(n=>`<article class="market-notification ${n.read_at?'':'unread'}">
    <div class="market-notification-copy">
      <div class="market-notification-heading"><strong>${html(n.title)}</strong><span>${formatDate(n.created_at)}</span></div>
      <p>${html(n.message)}</p>
      <small>${html(textStatus(n.type))}</small>
    </div>
    <button class="dash-action ${n.read_at?'':'primary'}" data-notification-open="${escAttr(n.id)}" data-target-tab="${escAttr(n.target_tab||'orders')}">View</button>
  </article>`).join('');
  el.innerHTML=`<div class="dash-panel">
    <div class="notification-panel-head"><div><h3>Your notifications</h3><p class="modal-intro">${state.unreadNotifications} unread · New orders, payment updates, dispatches, buyer cases and settlements appear here.</p></div>
    ${state.unreadNotifications?`<button class="dash-action" id="notifications-mark-all">Mark all as read</button>`:''}</div>
    <div class="notification-list">${content||'<div class="dash-empty">You are all caught up. New marketplace activity will appear here.</div>'}</div>
  </div>`;
  updateNotificationBadge();
}
async function pollNotifications(announceNew=false) {
  if(!state.user || !['buyer','seller','admin','super_admin'].includes(state.user.role)) return;
  try {
    const data=await api('notifications.list');
    const items=Array.isArray(data.notifications)?data.notifications:[];
    const latest=items[0];
    if(announceNew && state.notificationTopId && latest && latest.id!==state.notificationTopId) {
      notify('New ETHAN MARKET notification: '+latest.title);
    }
    if(latest) state.notificationTopId=latest.id;
    state.unreadNotifications=Number(data.unread_count||0);
    renderDashboardTabs();
    const modal=$('#dashboard-modal');
    if(modal && !modal.hidden && state.dashboardTab==='notifications') renderNotifications(data);
  } catch {}
}
function startNotificationPolling() {
  if(state.notificationTimer) clearInterval(state.notificationTimer);
  state.notificationTimer=null;
  state.notificationTopId=null;
  state.unreadNotifications=0;
  if(!state.user || !['buyer','seller','admin','super_admin'].includes(state.user.role)) { updateNotificationBadge(); return; }
  pollNotifications(false);
  state.notificationTimer=setInterval(()=>pollNotifications(true),30000);
}
async function openNotificationAction(button) {
  const id=button.dataset.notificationOpen;
  const target=button.dataset.targetTab||'orders';
  try {
    await api('notifications.mark-read',{id});
    await pollNotifications(false);
    state.dashboardTab=state.dashboardTabs.some(([tab])=>tab===target)?target:'notifications';
    loadDashboardTab();
  } catch(error) { notify(error.message); }
}
async function markAllNotificationsRead() {
  try {
    await api('notifications.mark-read',{all:true});
    await pollNotifications(false);
    if(state.dashboardTab==='notifications') loadDashboardTab();
    notify('All notifications marked as read.');
  } catch(error) { notify(error.message); }
}
function renderGrowthDashboard(data) {
  const referrals=data.referrals||{},conversions=data.conversions||{};
  const status=data.affiliate_status||'none';
  const recent=(data.recent||[]).map(r=>`<tr><td>${html(r.full_name)}</td><td>${statusPill(r.status)}</td><td>${formatDate(r.created_at)}</td></tr>`).join('')||tableEmpty('No one has joined from your link yet.',3);
  const inviteText=`Join me on ETHAN MARKET to discover products from independent sellers: ${data.referral_url}`;
  const apply=status==='none'||status==='paused'
    ? '<button class="button button-primary" id="affiliate-apply">Apply to become an ETHAN affiliate</button>'
    : status==='pending'?'<span class="status-pill pending">Affiliate application pending review</span>':'<span class="status-pill approved">Approved affiliate</span>';
  const store=data.store||null;
  const sellerMarketing=store
    ? store.seller_status==='approved'
      ? `<div class="dash-panel seller-marketing-panel">
          <h3>Promote your ETHAN MARKET store</h3>
          <p class="modal-intro">Your public store link is ready. Share it with customers on WhatsApp, Instagram, Facebook and anywhere your business connects with buyers.</p>
          <div class="growth-link-row"><input aria-label="Your public store link" readonly value="${escAttr(store.url)}"><button class="dash-action primary" data-growth-copy="${escAttr(store.url)}">Copy store link</button></div>
          <div class="growth-share-actions"><button class="dash-action primary" data-share-url="${escAttr(store.url)}" data-share-text="${escAttr('Shop '+store.store_name+' on ETHAN MARKET. Discover the store and its products:')}">Share store</button><button class="dash-action" data-share-url="${escAttr(store.url)}" data-share-channel="whatsapp" data-share-text="${escAttr('Shop '+store.store_name+' on ETHAN MARKET. Discover the store and its products:')}">Share on WhatsApp</button><a class="dash-action" href="${escAttr(store.url)}" target="_blank" rel="noopener">View store ↗</a></div>
          <h4 class="seller-marketing-subtitle">Share your live products</h4>
          <div class="seller-marketing-products">${(data.products||[]).map(p=>{
            const productMessage='Take a look at '+p.name+' from '+store.store_name+' on ETHAN MARKET:';
            return `<article class="seller-marketing-product"><div><strong>${html(p.name)}</strong><small>${money(p.price_kobo)}</small></div><div class="growth-share-actions"><button class="dash-action" data-growth-copy="${escAttr(p.url)}">Copy link</button><button class="dash-action primary" data-share-url="${escAttr(p.url)}" data-share-text="${escAttr(productMessage)}">Share</button></div></article>`;
          }).join('')||'<p class="modal-intro">Your approved products will appear here when they are published.</p>'}</div>
        </div>`
      : `<div class="dash-panel seller-marketing-panel"><h3>Your store marketing tools</h3><p class="modal-intro">Your seller application is currently ${html(store.seller_status)}. Your public store link and product promotion tools will appear here once the marketplace team approves your store.</p></div>`
    : '';
  $('#dashboard-content').innerHTML=`<div class="dash-panel">
    <h3>Your personal ETHAN MARKET invite link</h3>
    <p class="modal-intro">Invite friends, customers and business owners. Your referral link helps ETHAN MARKET measure new accounts, first purchases and approved sellers.</p>
    <div class="growth-link-row"><input aria-label="Your referral link" readonly value="${escAttr(data.referral_url)}"><button class="dash-action primary" data-growth-copy="${escAttr(data.referral_url)}">Copy link</button></div>
    <div class="growth-share-actions"><button class="dash-action primary" data-share-url="${escAttr(data.referral_url)}" data-share-text="${escAttr(inviteText)}">Share invite</button><button class="dash-action" data-share-url="${escAttr(data.referral_url)}" data-share-channel="whatsapp" data-share-text="${escAttr(inviteText)}">Share on WhatsApp</button></div>
    <div class="metric-grid">
      ${renderMetric('Sign-ups',referrals.signups||0)}
      ${renderMetric('First purchases',referrals.first_orders||0)}
      ${renderMetric('Approved sellers',referrals.approved_sellers||0)}
      ${renderMetric('Affiliate sales',money(conversions.sales_kobo||0))}
    </div>
  </div>
  ${sellerMarketing}
  <div class="dash-panel"><h3>ETHAN affiliate programme</h3>
    <p class="modal-intro">Approved affiliates earn a share of ETHAN MARKET's marketplace fee on eligible paid orders they refer. Seller earnings are not reduced by affiliate rewards. Rewards are reviewed and paid manually; there are no automatic transfers.</p>
    <div class="growth-affiliate-summary">
      <div>${statusPill(status)}<p class="modal-intro">Commission share: <strong>${(Number(data.affiliate_commission_bps||0)/100).toFixed(1)}%</strong> of ETHAN's marketplace fee</p></div>
      <div class="dash-actions">${apply}</div>
    </div>
    <div class="metric-grid">
      ${renderMetric('Referred orders',conversions.orders||0)}
      ${renderMetric('Awaiting review',money(conversions.awaiting_kobo||0))}
      ${renderMetric('Rewards paid',money(conversions.paid_kobo||0))}
    </div>
  </div>
  <div class="dash-panel"><h3>Referral activity</h3><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>New member</th><th>Milestone</th><th>Joined</th></tr></thead><tbody>${recent}</tbody></table></div></div>`;
}
function marketingCopyMessage(kind) {
  const url='https://market.ethandigitalacademy.org/';
  if(kind==='seller') return 'Do you own a business, sell products or create digital products? Bring your business to ETHAN MARKET, connect with new customers and grow your reach. Start your seller application here: '+url+'#sell';
  return 'Discover ETHAN MARKET — a marketplace for physical products, digital downloads and independent Nigerian businesses. Explore products, find new stores and shop with confidence: '+url;
}
function renderAdminGrowth(data) {
  const s=data.summary||{};
  const campaigns=(data.campaigns||[]).map(c=>{
    const link='https://market.ethandigitalacademy.org/?utm_campaign='+encodeURIComponent(c.slug)+'&utm_source='+encodeURIComponent(c.source||'ethan')+'&utm_medium='+encodeURIComponent(c.medium||'referral');
    return `<tr><td><strong>${html(c.name)}</strong><br><small>${html(c.slug)}</small></td><td>${html(c.source||'—')} / ${html(c.medium||'—')}</td><td>${c.visits||0}</td><td>${c.signup_views||0}</td><td>${c.signups||0}</td><td>${c.orders||0}</td><td>${money(c.budget_kobo||0)}</td><td>${money(c.gmv_kobo||0)}</td><td>${statusPill(c.status)}<br><button class="dash-action" data-growth-campaign-status="${c.id}" data-status="${c.status==='active'?'paused':'active'}">${c.status==='active'?'Pause':'Activate'}</button><button class="dash-action" data-growth-copy="${escAttr(link)}">Copy link</button></td></tr>`;
  }).join('')||tableEmpty('Create your first campaign to start measuring acquisition.',9);
  const promos=(data.promos||[]).map(p=>`<tr><td><strong>${html(p.code)}</strong></td><td>${(Number(p.discount_bps)/100).toFixed(1)}%</td><td>${p.max_redemptions||'Unlimited'}</td><td>${p.redemptions||0}</td><td>${money(p.discount_spend||0)}</td><td>${statusPill(p.active?'active':'paused')}<br><button class="dash-action" data-growth-promo-status="${p.id}" data-active="${p.active?'false':'true'}">${p.active?'Deactivate':'Activate'}</button></td></tr>`).join('')||tableEmpty('No promo codes created yet.',6);
  const affiliates=(data.affiliates||[]).map(a=>`<tr><td><strong>${html(a.full_name)}</strong><br><small>${html(a.email)}</small></td><td>${html(a.referral_code)}</td><td>${statusPill(a.affiliate_status)}</td><td>${a.conversions||0}</td><td>${money(a.awaiting_kobo||0)}</td><td><input class="growth-affiliate-rate" type="number" min="0" max="50" step="0.5" aria-label="Marketplace fee share percentage" value="${(Number(a.affiliate_commission_bps||2000)/100).toFixed(1)}" data-affiliate-rate="${a.user_id}"></td><td><div class="dash-actions"><button class="dash-action primary" data-growth-affiliate="${a.user_id}" data-status="approved">Approve / save rate</button><button class="dash-action" data-growth-affiliate="${a.user_id}" data-status="paused">Pause</button></div></td></tr>`).join('')||tableEmpty('No affiliate applications yet.',7);
  const conversions=(data.conversions||[]).map(x=>`<tr><td>${html(x.affiliate_name)}</td><td>${html(x.order_number)}</td><td>${money(x.sale_kobo)}</td><td>${money(x.commission_kobo)}</td><td>${statusPill(x.status)}</td><td><div class="dash-actions">${x.status==='pending'?'<button class="dash-action primary" data-affiliate-conversion="'+x.id+'" data-status="approved">Approve</button>':''}${x.status==='approved'?'<button class="dash-action primary" data-affiliate-conversion="'+x.id+'" data-status="paid">Mark paid</button>':''}${x.status==='pending'?'<button class="dash-action danger" data-affiliate-conversion="'+x.id+'" data-status="void">Void</button>':''}</div>${x.payout_reference?'<small>'+html(x.payout_reference)+'</small>':''}</td></tr>`).join('')||tableEmpty('No affiliate purchases recorded yet.',6);
  const referrals=(data.referrals||[]).map(r=>`<tr><td>${html(r.referrer_name)}</td><td>${html(r.referred_name)}<br><small>${html(r.referred_email)}</small></td><td>${html(r.referral_code)}</td><td>${statusPill(r.status)}</td><td>${formatDate(r.created_at)}</td></tr>`).join('')||tableEmpty('No referred accounts yet.',5);
  $('#dashboard-content').innerHTML=`<div class="metric-grid">
    ${renderMetric('New accounts · 30 days',s.signups_30d||0)}
    ${renderMetric('Referred sign-ups',s.referred_signups_30d||0)}
    ${renderMetric('Referred buyers',s.referred_buyers_30d||0)}
    ${renderMetric('Referred sellers · 30 days',s.referred_sellers_30d||0)}
    ${renderMetric('Approved sellers · 30 days',s.approved_sellers_30d||0)}
    ${renderMetric('Paid orders · 30 days',s.paid_orders_30d||0)}
    ${renderMetric('Marketplace GMV · 30 days',money(s.gmv_30d||0))}
    ${renderMetric('Promo redemptions · 30 days',s.promo_redemptions_30d||0)}
    ${renderMetric('Pending affiliate rewards',s.affiliate_pending||0)}
  </div>
  <div class="dash-panel marketing-launch-kit">
    <h3>ETHAN MARKET launch and sharing kit</h3>
    <p class="modal-intro">Use these ready-to-share messages to introduce the marketplace to shoppers and invite businesses to sell. For channel-by-channel reporting, create a campaign below and share its tracked link.</p>
    <div class="marketing-copy-grid">
      <article><span class="eyebrow">BUYER INVITE</span><h4>Bring shoppers to the market</h4><p>Introduce buyers to products, digital downloads and independent Nigerian stores.</p><div class="growth-share-actions"><button class="dash-action primary" data-marketing-copy="buyer">Copy buyer message</button><button class="dash-action" data-share-url="https://market.ethandigitalacademy.org/" data-share-text="Discover ETHAN MARKET — a marketplace for physical products, digital downloads and independent Nigerian businesses. Explore products and find new stores.">Share marketplace</button></div></article>
      <article><span class="eyebrow">SELLER INVITE</span><h4>Recruit independent businesses</h4><p>Invite business owners, product sellers and digital creators to apply for a store.</p><div class="growth-share-actions"><button class="dash-action primary" data-marketing-copy="seller">Copy seller message</button><a class="dash-action" href="https://market.ethandigitalacademy.org/#sell" target="_blank" rel="noopener">Open seller section ↗</a></div></article>
    </div>
  </div>
  <div class="dash-panel"><h3>Create an acquisition campaign</h3><p class="modal-intro">Use the generated link in adverts, WhatsApp posts, influencer campaigns and seller recruitment messages. Traffic, sign-up visits and paid orders are measured against the campaign slug.</p>
    <form class="dash-form" id="growth-campaign-form">
      <div class="form-field"><label for="growth-campaign-name">Campaign name</label><input id="growth-campaign-name" required maxlength="120" placeholder="Lagos seller launch"></div>
      <div class="form-field"><label for="growth-campaign-slug">Campaign URL slug</label><input id="growth-campaign-slug" required maxlength="80" placeholder="lagos-seller-launch"></div>
      <div class="form-field"><label for="growth-campaign-source">Source</label><input id="growth-campaign-source" maxlength="80" placeholder="instagram / whatsapp"></div>
      <div class="form-field"><label for="growth-campaign-medium">Medium</label><input id="growth-campaign-medium" maxlength="80" placeholder="social / influencer / referral"></div>
      <div class="form-field"><label for="growth-campaign-budget">Budget (₦)</label><input id="growth-campaign-budget" type="number" min="0" step="100" value="0"></div>
      <button class="button button-primary" type="submit">Create campaign</button><p class="form-error" id="growth-campaign-error"></p>
    </form>
  </div>
  <div class="dash-panel"><h3>Create a buyer promo code</h3><p class="modal-intro">Promo discounts are capped at ETHAN MARKET's commission on the basket. They do not reduce the seller's recorded earnings.</p>
    <form class="dash-form" id="growth-promo-form">
      <div class="form-field"><label for="growth-promo-code">Promo code</label><input id="growth-promo-code" required maxlength="40" placeholder="WELCOME10"></div>
      <div class="form-field"><label for="growth-promo-discount">Discount (%)</label><input id="growth-promo-discount" type="number" min="0.1" max="100" step="0.1" required value="10"></div>
      <div class="form-field"><label for="growth-promo-cap">Maximum discount (₦, optional)</label><input id="growth-promo-cap" type="number" min="0" step="100" value="0"></div>
      <div class="form-field"><label for="growth-promo-minimum">Minimum basket (₦)</label><input id="growth-promo-minimum" type="number" min="0" step="100" value="0"></div>
      <div class="form-field"><label for="growth-promo-uses">Maximum redemptions (0 = unlimited)</label><input id="growth-promo-uses" type="number" min="0" step="1" value="100"></div>
      <button class="button button-primary" type="submit">Create promo code</button><p class="form-error" id="growth-promo-error"></p>
    </form>
  </div>
  <div class="dash-panel"><h3>Campaign performance</h3><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Campaign</th><th>Source / medium</th><th>Visits</th><th>Sign-up views</th><th>Sign-ups</th><th>Paid orders</th><th>Budget</th><th>GMV</th><th>Management</th></tr></thead><tbody>${campaigns}</tbody></table></div></div>
  <div class="dash-panel"><h3>Promo codes</h3><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Code</th><th>Discount</th><th>Max uses</th><th>Redeemed</th><th>Discount spend</th><th>Status</th></tr></thead><tbody>${promos}</tbody></table></div></div>
  <div class="dash-panel"><h3>Affiliate applications and rates</h3><p class="modal-intro">The rate is a percentage of ETHAN MARKET's commission, not a percentage of seller revenue. Approved rewards are tracked here and paid manually after review.</p><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Affiliate</th><th>Code</th><th>Status</th><th>Orders</th><th>Awaiting reward</th><th>Fee share %</th><th>Actions</th></tr></thead><tbody>${affiliates}</tbody></table></div></div>
  <div class="dash-panel"><h3>Affiliate conversion ledger</h3><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Affiliate</th><th>Order</th><th>Sales</th><th>Reward</th><th>Status</th><th>Actions</th></tr></thead><tbody>${conversions}</tbody></table></div></div>
  <div class="dash-panel"><h3>Referral register</h3><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Referrer</th><th>New account</th><th>Code</th><th>Milestone</th><th>Joined</th></tr></thead><tbody>${referrals}</tbody></table></div></div>`;
}

function renderMetric(label,value) { return `<div class="metric-card"><small>${html(label)}</small><b>${html(value)}</b></div>`; }
function renderAdminTab(tab,data) {
  const el=$('#dashboard-content');
  if(tab==='overview') {
    el.innerHTML=`<div class="metric-grid">${renderMetric('Paid GMV',money(data.orders?.gmv))}${renderMetric('Paid orders',data.orders?.paid_orders||0)}${renderMetric('Approved stores',data.sellers?.approved||0)}${renderMetric('Pending seller applications',data.sellers?.pending||0)}${renderMetric('Pending payouts',money(data.payouts?.outstanding))}${renderMetric('Marketplace commission',money(data.finance?.marketplace_commission_kobo))}${renderMetric('Paystack fees (Ethan)',money(data.finance?.gateway_fee_kobo))}${renderMetric('Commission after gateway',money(Number(data.finance?.marketplace_commission_kobo||0)-Number(data.finance?.gateway_fee_kobo||0)))}</div>
      <div class="dash-panel seller-review-queue"><h3>Seller applications awaiting review</h3><p class="modal-intro">${Number(data.sellers?.pending||0)} application(s) are waiting for your decision.</p><button class="dash-action primary" data-dash-tab="sellers">Review seller applications →</button></div>
      <div class="dash-panel"><h3>Recent orders</h3><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Order</th><th>Buyer</th><th>Total</th><th>Payment</th><th>Created</th></tr></thead><tbody>${(data.recent||[]).map(o=>`<tr><td><strong>${html(o.order_number)}</strong></td><td>${html(o.buyer_email)}</td><td>${money(o.total_kobo)}</td><td>${statusPill(o.payment_status)}</td><td>${formatDate(o.created_at)}</td></tr>`).join('')||tableEmpty('No orders yet.',5)}</tbody></table></div></div>`;
  } else if(tab==='sellers') {
    el.innerHTML=`<div class="dash-panel"><h3>Seller applications and stores</h3><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Store</th><th>Owner</th><th>Location</th><th>Status</th><th>Actions</th></tr></thead><tbody>${(data.sellers||[]).map(s=>`<tr><td><strong>${html(s.store_name)}</strong><br><small>${html(s.slug)}</small></td><td>${html(s.user_name)}<br>${html(s.email)}</td><td>${html([s.city,s.state].filter(Boolean).join(', ')||'—')}</td><td>${statusPill(s.seller_status)}</td><td><div class="dash-actions">${s.seller_status!=='approved'?`<button class="dash-action primary" data-admin-action="seller-status" data-id="${s.id}" data-status="approved">Approve</button>`:''}${s.seller_status!=='rejected'?`<button class="dash-action danger" data-admin-action="seller-status" data-id="${s.id}" data-status="rejected">Reject</button>`:''}${s.seller_status==='approved'?`<button class="dash-action" data-admin-action="seller-status" data-id="${s.id}" data-status="suspended">Suspend</button>`:''}</div></td></tr>`).join('')||tableEmpty('No seller applications yet.',5)}</tbody></table></div></div>`;
  } else if(tab==='products') {
    el.innerHTML=`<div class="dash-panel"><h3>Product review queue</h3><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Product</th><th>Store</th><th>Price</th><th>Stock</th><th>Status</th><th>Actions</th></tr></thead><tbody>${(data.products||[]).map(p=>`<tr><td><strong>${html(p.name)}</strong><br><small>${html(p.category_name||p.product_type)}</small></td><td>${html(p.store_name)}</td><td>${money(p.price_kobo)}</td><td>${p.product_type==='digital'?'Digital':p.stock_qty}</td><td>${statusPill(p.status)}</td><td><div class="dash-actions">${p.status!=='active'?`<button class="dash-action primary" data-admin-action="product-status" data-id="${p.id}" data-status="active">Approve</button>`:''}${p.status!=='rejected'?`<button class="dash-action danger" data-admin-action="product-status" data-id="${p.id}" data-status="rejected">Reject</button>`:''}${p.status==='active'?`<button class="dash-action" data-admin-action="product-status" data-id="${p.id}" data-status="active" data-featured="${p.featured?'false':'true'}">${p.featured?'Unfeature':'Feature'}</button>`:''}</div></td></tr>`).join('')||tableEmpty('No products have been submitted.',6)}</tbody></table></div></div>`;
  } else if(tab==='orders') {
    el.innerHTML=`<div class="dash-panel"><h3>All marketplace orders</h3><p class="modal-intro">For a physical item that the buyer has not confirmed, an administrator may record independently verified courier or delivery evidence to start the protection window. Do not use this unless delivery evidence has been checked.</p><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Order</th><th>Buyer</th><th>Amount</th><th>Payment</th><th>Fulfilment / items</th><th>Update</th></tr></thead><tbody>${(data.orders||[]).map(o=>`<tr><td><strong>${html(o.order_number)}</strong><br><small>${formatDate(o.created_at)}</small></td><td>${html(o.recipient_name)}<br>${html(o.buyer_email)}</td><td>${money(o.total_kobo)}</td><td>${statusPill(o.payment_status)}</td><td>${statusPill(o.status)}${(o.items||[]).map(i=>`<div class="dash-panel"><strong>${html(i.product_name)} × ${i.quantity}</strong><br><small>${html(textStatus(i.fulfillment_status))} · ${html(i.tracking_carrier||'')} ${html(i.tracking_number||'')}</small>${o.payment_status==='paid'&&i.product_type==='physical'&&!['delivered','cancelled'].includes(i.fulfillment_status)?`<br><button class="dash-action primary" data-admin-confirm-delivery="${i.id}">Verify delivery evidence</button>`:''}</div>`).join('')}</td><td><select class="dash-action" data-order-status="${o.id}"><option value="">Change…</option>${['processing','dispatched','delivered','cancelled'].map(x=>`<option value="${x}">${textStatus(x)}</option>`).join('')}</select></td></tr>`).join('')||tableEmpty('No orders yet.',6)}</tbody></table></div></div>`;
  } else if(tab==='disputes') {
    el.innerHTML=`<div class="dash-panel"><h3>Buyer protection cases</h3><p class="modal-intro">Review both sides before deciding. For buyer refunds, complete the refund with the payment provider first and record its reference.</p><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Order / item</th><th>Buyer</th><th>Seller</th><th>Reason / buyer details</th><th>Seller response</th><th>Status / decision</th></tr></thead><tbody>${(data.disputes||[]).map(d=>`<tr><td><strong>${html(d.order_number)}</strong><br>${html(d.product_name)} × ${d.quantity}</td><td>${html(d.buyer_name)}<br><small>${html(d.buyer_email)}</small></td><td>${html(d.store_name)}<br><small>${html(d.seller_name)}</small></td><td><strong>${html(textStatus(d.reason))}</strong><br><small>${html(d.details)}</small></td><td>${html(d.seller_response||'Awaiting seller response')}</td><td>${statusPill(d.status)}${['open','under_review'].includes(d.status)?`<div class="dash-actions"><button class="dash-action primary" data-dispute-resolve="${d.id}" data-outcome="seller">Release to seller</button><button class="dash-action danger" data-dispute-resolve="${d.id}" data-outcome="buyer">Resolve for buyer / refund</button></div>`: `<small>${html(d.resolution_notes||'')}</small>`}</td></tr>`).join('')||tableEmpty('No buyer disputes have been opened.',6)}</tbody></table></div></div>`;
  } else if(tab==='payouts') {
    el.innerHTML=`<div class="dash-panel"><h3>Seller settlement ledger</h3><p class="modal-intro">Only approve a payout after its protection date has passed and no open dispute exists. Complete the bank transfer, then record its cleared reference.</p><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Seller / order</th><th>Settlement account</th><th>Gross</th><th>Commission</th><th>Net payable</th><th>Protection / status</th><th>Record payout</th></tr></thead><tbody>${(data.payouts||[]).map(p=>{const eligible=!!p.eligible_at&&new Date(p.eligible_at).getTime()<=Date.now();return `<tr><td><strong>${html(p.store_name)}</strong><br><small>${html(p.order_number)} · ${html(p.email)}</small></td><td><strong>${html(p.bank_name||'Bank not supplied')}</strong><br><small>${html(p.account_name||'')} · ${html(p.account_number||'')}</small></td><td>${money(p.gross_kobo)}</td><td>${money(p.commission_kobo)}</td><td>${money(p.net_kobo)}</td><td>${statusPill(p.status)}<br><small>${p.eligible_at?'Eligible: '+formatDate(p.eligible_at):'Awaiting buyer receipt confirmation'}</small><br><small>${html(p.hold_reason||'')}</small>${p.payout_reference?`<br><small>${html(p.payout_reference)}</small>`:''}</td><td><div class="dash-actions">${p.status==='pending'&&eligible?`<button class="dash-action" data-admin-action="payout-status" data-id="${p.id}" data-status="approved">Approve</button>`:''}${p.status==='approved'?`<button class="dash-action primary" data-admin-action="payout-status" data-id="${p.id}" data-status="paid">Mark paid</button>`:''}</div></td></tr>`;}).join('')||tableEmpty('No settlement records yet.',7)}</tbody></table></div></div>`;
  } else if(tab==='growth') {
    renderAdminGrowth(data);
  } else if(tab==='settings') {
    const settings=data.settings||{},zones=data.delivery_zones||[];
    const zoneRows=zones.map(z=>`<tr><td><strong>${html(z.name)}</strong>${z.is_fallback?'<br><small>Fallback zone</small>':''}</td><td>${html(z.state)} / ${html(z.city)}</td><td>${money(z.fee_kobo)}</td><td>${statusPill(z.active?'active':'paused')}</td><td><button class="dash-action" data-zone-edit="${z.id}" data-zone-name="${escAttr(z.name)}" data-zone-state="${escAttr(z.state)}" data-zone-city="${escAttr(z.city)}" data-zone-fee="${Number(z.fee_kobo)}">Edit</button>${z.is_fallback?'':` <button class="dash-action" data-zone-toggle="${z.id}" data-active="${z.active?'false':'true'}">${z.active?'Pause':'Activate'}</button>`}</td></tr>`).join('')||tableEmpty('No delivery zones configured.',5);
    el.innerHTML=`<div class="dash-panel"><h3>Marketplace commercial settings</h3><form class="dash-form" id="market-settings-form"><div class="form-field"><label for="market-commission">Seller commission (%)</label><input id="market-commission" type="number" min="0" max="50" step="0.5" value="${(Number(settings.commission_bps||500)/100).toFixed(1)}"></div><div class="form-field"><label for="market-hold-days">Seller payout protection period (days)</label><input id="market-hold-days" type="number" min="1" max="30" step="1" value="${Number(settings.seller_payout_hold_days||7)}"></div><button class="button button-primary" type="submit">Save marketplace settings</button><p class="form-error" id="market-settings-error"></p></form><p class="modal-intro">Payment processing is paid by ETHAN MARKET. Buyers see no separate gateway surcharge, and seller settlement is calculated from the 5% commission.</p></div>
    <div class="dash-panel"><h3>Delivery zones and fees</h3><p class="modal-intro">Add destination-specific prices. Exact city + state zones take priority, then state-wide zones, then the nationwide fallback. Fees are manually managed estimates until a courier quote integration is connected.</p><form class="dash-form" id="delivery-zone-form"><input id="delivery-zone-id" type="hidden"><div class="form-field"><label for="delivery-zone-name">Zone name</label><input id="delivery-zone-name" required maxlength="100" placeholder="Lagos Mainland"></div><div class="form-field"><label for="delivery-zone-state">State (or * for all)</label><input id="delivery-zone-state" required maxlength="80" value="Lagos" placeholder="Lagos"></div><div class="form-field"><label for="delivery-zone-city">City (or * for all)</label><input id="delivery-zone-city" required maxlength="80" value="*" placeholder="Ikeja or *"></div><div class="form-field"><label for="delivery-zone-fee">Delivery fee (₦)</label><input id="delivery-zone-fee" type="number" min="0" step="50" required></div><button class="button button-primary" type="submit">Save delivery zone</button><button class="dash-action" id="delivery-zone-reset" type="button">Clear form</button><p class="form-error" id="delivery-zone-error"></p></form><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Zone</th><th>State / city</th><th>Fee</th><th>Status</th><th>Actions</th></tr></thead><tbody>${zoneRows}</tbody></table></div></div>
    <div class="dash-panel"><h3>Payments configuration</h3><p class="modal-intro">Paystack checkout is ${state.config.payments_enabled?'configured':'not yet enabled'}. Add your Paystack secret key to the Vercel project environment to activate initialize, verify and webhook payments. Never put the secret key in this page.</p><span class="status-pill ${state.config.payments_enabled?'active':'pending'}">${state.config.payments_enabled?'Payments enabled':'Awaiting merchant keys'}</span></div>`;
  }
}
function renderSellerTab(tab,data) {
  const el=$('#dashboard-content');
  if(tab==='overview') {
    const products=data.products||[],orders=data.orders||[];
    const counts={active:products.filter(p=>p.status==='active').length,pending:products.filter(p=>p.status==='pending').length,draft:products.filter(p=>p.status==='draft').length,rejected:products.filter(p=>p.status==='rejected').length};
    const storeUrl='https://market.ethandigitalacademy.org/store/'+encodeURIComponent(data.seller?.slug||'');
    const referralUrl=data.referral_url||'';
    const storeMessage='Shop '+(data.seller?.store_name||'my store')+' on ETHAN MARKET. Discover my products:';
    const inviteMessage='Join me on ETHAN MARKET and discover products from independent Nigerian businesses:';
    const analytics=data.sales_analytics||{},summary=analytics.summary||{},daily=analytics.daily||[],top=analytics.top_products||[];
    const currentSales=Number(summary.current_month_sales_kobo||0),previousSales=Number(summary.previous_month_sales_kobo||0);
    const monthChange=previousSales>0?Math.round((currentSales-previousSales)/previousSales*100):null;
    const maxDaily=Math.max(1,...daily.map(x=>Number(x.sales_kobo||0)));
    const dailyBars=daily.map(x=>{const value=Number(x.sales_kobo||0),height=Math.max(value>0?5:2,Math.round(value/maxDaily*100));return `<div class="seller-sales-bar-item" title="${formatDate(x.day)}: ${money(value)}"><div class="seller-sales-bar-track"><div class="seller-sales-bar" style="height:${height}%"></div></div><small>${new Date(x.day).toLocaleDateString('en-NG',{day:'numeric',month:'short'})}</small></div>`;}).join('');
    const topRows=top.map((x,i)=>`<tr><td>${i+1}. ${html(x.product_name)}</td><td>${Number(x.units||0)}</td><td>${Number(x.orders||0)}</td><td>${money(x.sales_kobo)}</td></tr>`).join('')||tableEmpty('No paid product sales yet.',4);
    el.innerHTML=`<div class="dash-panel"><h3>${html(data.seller?.store_name||'Your store')}</h3><p class="modal-intro">Your seller studio is ready. Add products, manage inventory and share your store with customers. New and edited listings are reviewed before publication.</p><div class="metric-grid">${renderMetric('All products',products.length)}${renderMetric('Published',counts.active)}${renderMetric('Awaiting review',counts.pending)}${renderMetric('Paid order items',orders.length)}${renderMetric('Pending settlement',money(data.totals?.outstanding))}${renderMetric('Payouts recorded',money(data.totals?.paid))}</div><div class="dash-actions"><button class="button button-primary" id="add-product-button">Add a product +</button><button class="dash-action" data-dash-tab="products">Manage products</button><span class="status-pill approved">Seller approved</span></div></div>
    <div class="dash-panel seller-marketing-panel"><h3>Your store link</h3><p class="modal-intro">Share your public storefront so customers can browse all your published products.</p><div class="growth-link-row"><input aria-label="Your public store link" readonly value="${escAttr(storeUrl)}"><button class="dash-action primary" data-growth-copy="${escAttr(storeUrl)}">Copy store link</button></div><div class="growth-share-actions"><button class="dash-action primary" data-share-url="${escAttr(storeUrl)}" data-share-text="${escAttr(storeMessage)}">Share store</button><button class="dash-action" data-share-url="${escAttr(storeUrl)}" data-share-channel="whatsapp" data-share-text="${escAttr(storeMessage)}">Share on WhatsApp</button><a class="dash-action" href="${escAttr(storeUrl)}" target="_blank" rel="noopener">View store ↗</a></div></div>
    <div class="dash-panel seller-marketing-panel"><h3>Your personal referral link</h3><p class="modal-intro">Invite buyers and business owners to ETHAN MARKET. Referrals are tracked separately from your store sales.</p><div class="growth-link-row"><input aria-label="Your personal referral link" readonly value="${escAttr(referralUrl)}"><button class="dash-action primary" data-growth-copy="${escAttr(referralUrl)}">Copy referral link</button></div><div class="growth-share-actions"><button class="dash-action primary" data-share-url="${escAttr(referralUrl)}" data-share-text="${escAttr(inviteMessage)}">Share referral link</button><button class="dash-action" data-share-url="${escAttr(referralUrl)}" data-share-channel="whatsapp" data-share-text="${escAttr(inviteMessage)}">Share on WhatsApp</button><button class="dash-action" data-dash-tab="growth">View referral performance</button></div></div>`;
    el.innerHTML+=`<div class="dash-panel seller-analytics-panel"><div class="dashboard-head"><div><h3>Sales performance</h3><p class="modal-intro">Paid sales only. Product revenue is shown before commission and other seller costs.</p></div><span class="status-pill active">Live seller data</span></div><div class="metric-grid">${renderMetric('All-time sales',money(summary.all_time_sales_kobo))}${renderMetric('This month',money(currentSales))}${renderMetric('Orders this month',Number(summary.current_month_orders||0))}${renderMetric('Units this month',Number(summary.current_month_units||0))}${renderMetric('All-time orders',Number(summary.all_time_orders||0))}${renderMetric('All-time units',Number(summary.all_time_units||0))}</div><p class="seller-sales-comparison">${monthChange===null?'No previous-month sales baseline yet.':`Month-on-month sales ${monthChange>=0?'increased':'decreased'} by <strong>${Math.abs(monthChange)}%</strong> compared with last month.`}</p><h4>Daily sales — last 14 days</h4><div class="seller-sales-chart">${dailyBars||'<p class="modal-intro">No paid sales recorded in the last 14 days.</p>'}</div><h4>Best-selling products</h4><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Product</th><th>Units sold</th><th>Orders</th><th>Sales</th></tr></thead><tbody>${topRows}</tbody></table></div></div>`;
  } else if(tab==='products') {
    const products=data.products||[];
    const counts={active:products.filter(p=>p.status==='active').length,pending:products.filter(p=>p.status==='pending').length,draft:products.filter(p=>p.status==='draft').length,rejected:products.filter(p=>p.status==='rejected').length};
    const lowStock=products.filter(p=>p.product_type==='physical'&&Number(p.stock_qty)<=5);
    el.innerHTML=`<div class="dash-panel"><div class="dashboard-head"><div><h3>Your products</h3><p class="modal-intro">Upload physical goods or digital products. Every new or edited listing enters review before it goes live.</p></div><button class="dash-action primary" id="add-product-button">Add product +</button></div><div class="metric-grid">${renderMetric('Published',counts.active)}${renderMetric('Awaiting review',counts.pending)}${renderMetric('Drafts',counts.draft)}${renderMetric('Needs attention',counts.rejected)}${renderMetric('Low stock (≤5)',lowStock.length)}</div><div class="dash-panel seller-bulk-import"><h3>Bulk product upload</h3><p class="modal-intro">Import up to 100 physical or digital products from a CSV spreadsheet. Download the template, fill it in, choose the file and preview your rows before submitting. All imported products enter admin review.</p><div class="dash-actions"><button type="button" class="dash-action" id="bulk-template-download">Download CSV template</button><label class="dash-action primary bulk-file-label" for="bulk-product-file">Choose CSV file</label><input id="bulk-product-file" type="file" accept=".csv,text/csv" hidden></div><p class="upload-state" id="bulk-upload-status" aria-live="polite">CSV only · Maximum 100 products per upload.</p><div id="bulk-preview-wrap" hidden><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Row</th><th>Product</th><th>Category</th><th>Type</th><th>Price</th><th>Validation</th></tr></thead><tbody id="bulk-preview-rows"></tbody></table></div><div class="dash-actions"><button type="button" class="button button-primary" id="bulk-submit-button" disabled>Submit valid products for review</button><button type="button" class="dash-action" id="bulk-clear-button">Clear file</button></div></div></div><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Product</th><th>Price</th><th>Type</th><th>Stock</th><th>Status</th><th>Action</th></tr></thead><tbody>${products.map(p=>`<tr><td><div class="seller-product-cell">${p.image_url?'<img src="'+escAttr(p.image_url)+'" alt="" loading="lazy">':''}<strong>${html(p.name)}</strong>${p.variants?.length?'<small class="seller-variant-stock">'+p.variants.map(v=>html(v.name)+': '+Number(v.stock_qty)).join(' · ')+'</small>':''}</div></td><td>${money(p.price_kobo)}</td><td>${html(p.product_type)}</td><td>${p.product_type==='digital'?'—':p.stock_qty}</td><td>${statusPill(p.status)}</td><td><button class="dash-action" data-edit-product="${p.id}">Edit</button></td></tr>`).join('')||tableEmpty('You have not added a product yet. Use Add product to list your first item.',6)}</tbody></table></div></div>`;
  } else if(tab==='orders') {
    el.innerHTML=`<div class="dash-panel"><h3>Customer orders</h3><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Order / item</th><th>Customer</th><th>Quantity</th><th>Delivery</th><th>Update</th></tr></thead><tbody>${(data.orders||[]).map(o=>`<tr><td><strong>${html(o.order_number)}</strong><br>${html(o.product_name)}<br><small>${formatDate(o.created_at)}</small></td><td>${html(o.recipient_name)}<br>${html(o.phone)}<br><small>${html([o.shipping_address?.line1,o.shipping_address?.city,o.shipping_address?.state].filter(Boolean).join(', '))}</small></td><td>${o.quantity}</td><td>${statusPill(o.fulfillment_status)}${o.tracking_number?`<br><small>${html(o.tracking_carrier)} ${html(o.tracking_number)}</small>`:''}</td><td><div class="dash-actions"><button class="dash-action" data-fulfill="${o.id}" data-status="processing">Processing</button><button class="dash-action primary" data-fulfill="${o.id}" data-status="dispatched">Dispatch / add tracking</button></div><small>Buyer confirms receipt in their order history.</small></td></tr>`).join('')||tableEmpty('No paid orders yet.',5)}</tbody></table></div></div>`;
  } else if(tab==='disputes') {
    el.innerHTML=`<div class="dash-panel"><h3>Buyer disputes</h3><p class="modal-intro">Respond promptly with dispatch details, proof of delivery or digital-access evidence.</p><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Order / product</th><th>Buyer issue</th><th>Your response</th><th>Status</th></tr></thead><tbody>${(data.disputes||[]).map(d=>`<tr><td><strong>${html(d.order_number)}</strong><br>${html(d.product_name)}</td><td>${html(textStatus(d.reason))}<br><small>${html(d.details)}</small></td><td>${html(d.seller_response||'No response yet')}${['open','under_review'].includes(d.status)?`<br><button class="dash-action primary" data-respond-dispute="${d.id}">Respond to case</button>`:''}</td><td>${statusPill(d.status)}<br><small>${html(d.resolution_notes||'')}</small></td></tr>`).join('')||tableEmpty('No buyer disputes against your store.',4)}</tbody></table></div></div>`;
  } else if(tab==='payouts') {
    el.innerHTML=`<div class="dash-panel"><h3>Settlement summary</h3><div class="metric-grid">${renderMetric('Pending',money(data.totals?.outstanding))}${renderMetric('Paid',money(data.totals?.paid))}${renderMetric('Total net earnings',money(data.totals?.net_total))}</div><p class="modal-intro">Payouts are protected until buyer receipt confirmation (physical items) or the digital-product protection period ends. Marketplace administration then approves and records the bank transfer.</p><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Created</th><th>Gross</th><th>Commission</th><th>Net</th><th>Protection / status</th><th>Reference</th></tr></thead><tbody>${(data.payouts||[]).map(p=>`<tr><td>${formatDate(p.created_at)}</td><td>${money(p.gross_kobo)}</td><td>${money(p.commission_kobo)}</td><td>${money(p.net_kobo)}</td><td>${statusPill(p.status)}<br><small>${p.eligible_at?'Eligible: '+formatDate(p.eligible_at):'Awaiting buyer receipt confirmation'}</small><br><small>${html(p.hold_reason||'')}</small></td><td>${html(p.payout_reference||'—')}</td></tr>`).join('')||tableEmpty('No payout entries yet.',6)}</tbody></table></div></div>`;
  }
}
function renderStoreSettings() {
  const s=state.sellerData?.seller||state.seller||{};
  $('#dashboard-content').innerHTML=`<div class="dash-panel"><h3>Store profile and settlement details</h3><form id="store-settings-form" class="dash-form"><div class="form-field full"><label>Store name</label><input value="${escAttr(s.store_name||'')}" disabled></div><div class="form-field full"><label for="profile-description">Store description</label><textarea id="profile-description" rows="3">${html(s.description||'')}</textarea></div><div class="form-field"><label for="profile-phone">Business phone</label><input id="profile-phone" value="${escAttr(s.phone||'')}"></div><div class="form-field"><label for="profile-whatsapp">WhatsApp</label><input id="profile-whatsapp" value="${escAttr(s.whatsapp||'')}"></div><div class="form-field"><label for="profile-city">City</label><input id="profile-city" value="${escAttr(s.city||'')}"></div><div class="form-field"><label for="profile-state">State</label><input id="profile-state" value="${escAttr(s.state||'')}"></div><div class="form-field"><label for="profile-bank">Bank name</label><input id="profile-bank" value="${escAttr(s.bank_name||'')}"></div><div class="form-field"><label for="profile-bank-code">Bank code</label><input id="profile-bank-code" value="${escAttr(s.bank_code||'')}"></div><div class="form-field"><label for="profile-account">Account number</label><input id="profile-account" value="${escAttr(s.account_number||'')}"></div><div class="form-field"><label for="profile-account-name">Account name</label><input id="profile-account-name" value="${escAttr(s.account_name||'')}"></div><p class="form-error" id="store-settings-error"></p><button class="button button-primary" type="submit">Save changes</button></form></div>`;
}
function renderBuyerOrders(orders) {
  $('#dashboard-content').innerHTML=`<div class="dash-panel"><h3>Your purchases and order protection</h3><p class="modal-intro">Check tracking, confirm receipt when an item arrives, or open a case if there is a problem. A reported issue blocks an unpaid seller payout while it is reviewed.</p><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Order</th><th>Items / protection</th><th>Total</th><th>Payment</th><th>Order status</th><th>Date</th></tr></thead><tbody>${orders.map(o=>`<tr><td><strong>${html(o.order_number)}</strong></td><td>${(o.items||[]).map(i=>{const activeCase=['open','under_review'].includes(i.dispute_status);return `<strong>${html(i.product_name)} × ${i.quantity}</strong>${i.download_url?`<br><a href="${escAttr(i.download_url)}" target="_blank" rel="noopener">Download digital item</a>`:''}${i.tracking_number?`<br><small>Tracking: ${html(i.tracking_carrier)} ${html(i.tracking_number)}</small>`:''}<br><small>Fulfilment: ${html(textStatus(i.fulfillment_status))} · Payout: ${html(textStatus(i.payout_status||'pending'))}</small>${i.buyer_confirmed_at?`<br><small>Receipt confirmed · Protection date: ${i.payout_eligible_at?formatDate(i.payout_eligible_at):'pending'}</small>`:''}${activeCase?`<br><small>Case ${html(i.dispute_status)}: ${html(textStatus(i.dispute_reason))}</small>`:''}${o.payment_status==='paid'&&i.product_type==='physical'&&!i.buyer_confirmed_at&&!activeCase&&['dispatched','delivered'].includes(i.fulfillment_status)?`<br><button class="dash-action primary" data-confirm-delivery="${escAttr(i.id)}">Confirm I received it</button>`:''}${o.payment_status==='paid'&&!i.dispute_id?`<br><button class="dash-action danger" data-open-dispute="${escAttr(i.id)}">Report a problem</button>`:''}${i.dispute_id&&!activeCase?`<br><small>Case closed: ${html(i.dispute_status)}</small>`:''}${i.fulfillment_status==='delivered'?`<br><button class="dash-action" data-review="${escAttr(i.product_id||'')}" data-order="${escAttr(o.id)}">Review item</button>`:''}`;}).join('<hr>')}</td><td>${money(o.total_kobo)}</td><td>${statusPill(o.payment_status)}</td><td>${statusPill(o.status)}</td><td>${formatDate(o.created_at)}</td></tr>`).join('')||tableEmpty('Your orders will appear here after checkout.',6)}</tbody></table></div></div>`;
}
function renderBuyerWishlist(products) {
  $('#dashboard-content').innerHTML=`<div class="dash-panel"><h3>Your wishlist</h3><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Product</th><th>Store</th><th>Price</th><th></th></tr></thead><tbody>${products.map(p=>`<tr><td><strong>${html(p.name)}</strong></td><td>${html(p.store_name)}</td><td>${money(p.price_kobo)}</td><td><button class="dash-action" data-add="${p.id}">Add to bag</button></td></tr>`).join('')||tableEmpty('No saved products yet.',4)}</tbody></table></div></div>`;
}
function openSellerApplication() {
  if(!state.user){openAuth('register','Create your buyer account first. You can submit your seller application after signing in.');return;}
  if(state.seller){if(state.seller.seller_status==='approved'){openDashboard('overview');return;}notify('Your seller application is ' + state.seller.seller_status + '.');openDashboard('sell');return;}
  showModal('seller-modal');
}
async function submitSellerApplication(e) {
  e.preventDefault(); $('#seller-error').textContent='';
  const payload={...growthPayload(),store_name:$('#store-name').value,slug:$('#store-slug').value,description:$('#store-description').value,phone:$('#seller-phone').value,whatsapp:$('#seller-whatsapp').value,business_type:$('#business-type').value,city:$('#seller-city').value,state:$('#seller-state').value,bank_name:$('#seller-bank').value,bank_code:$('#seller-bank-code').value,account_number:$('#seller-account').value,account_name:$('#seller-account-name').value};
  const submit=$('#seller-form button[type=submit]');submit.disabled=true;
  try {const data=await api('seller.apply',payload);state.seller=data.seller;closeModal('seller-modal');notify('Seller application submitted for review.');openDashboard('sell');}
  catch(err){$('#seller-error').textContent=err.message;} finally{submit.disabled=false;}
}
function renderProductImagePreview(url) {
  const preview=$('#product-image-preview');
  const image=$('#product-image-preview-img');
  const clear=$('#product-image-clear');
  const value=String(url||'').trim();
  const valid=/^https:\/\//i.test(value);
  preview.hidden=!valid;
  clear.hidden=!valid;
  if(valid){image.src=value;image.alt='Product photo preview';image.onerror=()=>{preview.hidden=true;clear.hidden=true;};}
  else {image.removeAttribute('src');image.onerror=null;}
}
function openProductEditor(product) {
  $('#product-form').reset();
  $('#product-id').value=product?.id||'';
  $('#product-title').textContent=product?'Edit product.':'Add a product.';
  $('#product-error').textContent='';
  $('#image-upload-state').textContent='';
  $('#product-image-file').value='';
  renderProductImagePreview('');
  if(product){
    $('#product-name').value=product.name||'';
    $('#product-category').value=state.categories.find(c=>c.name===product.category_name)?.id||state.categories[0]?.id||'';
    $('#product-type').value=product.product_type||'physical';
    $('#product-price').value=Number(product.price_kobo)/100;
    $('#product-compare').value=product.compare_at_kobo?Number(product.compare_at_kobo)/100:'';
    $('#product-stock').value=product.stock_qty||1;
    $('#product-sku').value=product.sku||'';
    $('#product-image').value=product.image_url||'';
    $('#product-description').value=product.description||'';
    $('#digital-url').value=product.digital_delivery_url||'';
    $('#product-variants').value=(product.variants||[]).map(v=>[v.name,v.sku,Number(v.price_kobo)===Number(product.price_kobo)?'':Number(v.price_kobo)/100,v.stock_qty].join(' | ')).join('\n');
  }
  renderProductImagePreview($('#product-image').value);
  updateProductType();
  showModal('product-modal');
  setTimeout(()=>$('#product-name').focus({preventScroll:true}),0);
}
function updateProductType(){
  const isDigital=$('#product-type').value==='digital';
  $('#product-stock-wrap').hidden=isDigital||!!$('#product-variants').value.trim();
  $('#product-variants-wrap').hidden=isDigital;
  $('#digital-url-wrap').hidden=!isDigital;
  $('#product-stock').required=!isDigital&&!$('#product-variants').value.trim();
  $('#product-stock').disabled=isDigital;
  if(isDigital)$('#product-stock').value=0;
  else if(!Number($('#product-stock').value))$('#product-stock').value=1;
}
async function uploadProductImage(e){
  const file=e.target.files?.[0];
  if(!file)return;
  const stateEl=$('#image-upload-state');
  const button=$('#product-form button[type=submit]');
  const allowed={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/avif':'avif'};
  const extension=(file.name.split('.').pop()||'').toLowerCase();
  const mime=allowed[file.type]?file.type:Object.keys(allowed).find(type=>allowed[type]===extension);
  if(!mime){stateEl.textContent='Choose a JPG, PNG, WebP or AVIF image.';e.target.value='';return;}
  if(file.size<1||file.size>2.5*1024*1024){stateEl.textContent='Choose an image smaller than 2.5 MB.';e.target.value='';return;}
  button.disabled=true;
  stateEl.textContent='Uploading your product photo securely…';
  try{
    const dataUrl=await new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onload=()=>resolve(reader.result);
      reader.onerror=()=>reject(new Error('Could not read this image. Please choose it again.'));
      reader.readAsDataURL(file);
    });
    const match=String(dataUrl).match(/^data:(image\/(?:jpeg|png|webp|avif));base64,([A-Za-z0-9+/=]+)$/);
    if(!match)throw new Error('The selected image could not be prepared. Try another photo.');
    const response=await fetch('/api/market-upload',{
      method:'POST',credentials:'same-origin',cache:'no-store',
      headers:{'Content-Type':'application/json','Accept':'application/json'},
      body:JSON.stringify({file_name:file.name,mime_type:mime,base64:match[2]})
    });
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result.error||'Photo upload failed. Please try again.');
    const url=result.data?.url;
    if(!url||!/^https:\/\//i.test(url))throw new Error('The image service did not return a valid photo URL.');
    $('#product-image').value=url;
    renderProductImagePreview(url);
    stateEl.textContent='Photo uploaded and attached to this product.';
  }catch(err){
    stateEl.textContent=err.message||'Photo upload failed.';
    e.target.value='';
  }finally{
    button.disabled=false;
  }
}

let bulkImportRows=[];
function parseMarketCsv(source){
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<source.length;i++){
    const ch=source[i],next=source[i+1];
    if(quoted){if(ch==='"'&&next==='"'){cell+='"';i++;}else if(ch==='"')quoted=false;else cell+=ch;}
    else if(ch==='"')quoted=true;
    else if(ch===','){row.push(cell);cell='';}
    else if(ch==='\n'){row.push(cell);rows.push(row);row=[];cell='';}
    else if(ch!=='\r')cell+=ch;
  }
  if(quoted)throw new Error('The CSV file has an unclosed quotation mark.');
  if(cell.length||row.length){row.push(cell);rows.push(row);}
  return rows.filter(r=>r.some(v=>String(v).trim()!==''));
}
function downloadBulkTemplate(){
  const headers=['name','category','product_type','price','compare_at_price','stock_qty','sku','image_url','description','digital_delivery_url'];
  const category=state.categories?.[0]?.slug||'category-slug';
  const sample=['Sample product',category,'physical','5000','6500','10','SKU-001','','Describe your product in at least 10 characters',''];
  const csv=[headers,sample].map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download='ethan-market-product-upload-template.csv';document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url);
}
function validateBulkFile(source){
  const parsed=parseMarketCsv(source);
  if(parsed.length<2)throw new Error('The CSV must contain a header row and at least one product.');
  const headers=parsed[0].map(x=>String(x).trim().toLowerCase());
  const required=['name','category','product_type','price','stock_qty','description'];
  const missing=required.filter(x=>!headers.includes(x));
  if(missing.length)throw new Error('Missing required columns: '+missing.join(', '));
  const allowed=['name','category','product_type','price','compare_at_price','stock_qty','sku','image_url','description','digital_delivery_url'];
  const index={};headers.forEach((h,i)=>{if(allowed.includes(h))index[h]=i;});
  const raw=parsed.slice(1);
  if(raw.length>100)throw new Error('Maximum 100 products per upload. Split larger catalogues into separate files.');
  const seen=new Set();
  return raw.map((values,i)=>{
    const get=k=>String(values[index[k]]??'').trim();
    const row={row_number:i+2,name:get('name'),category:get('category'),product_type:get('product_type').toLowerCase()==='digital'?'digital':'physical',price:get('price'),compare_at_price:get('compare_at_price'),stock_qty:get('stock_qty'),sku:get('sku'),image_url:get('image_url'),description:get('description'),digital_delivery_url:get('digital_delivery_url'),errors:[]};
    if(row.name.length<3)row.errors.push('Name is too short');
    const category=state.categories.find(c=>c.slug?.toLowerCase()===row.category.toLowerCase()||c.name?.toLowerCase()===row.category.toLowerCase());
    if(!category)row.errors.push('Unknown category');else row.category_id=category.id;
    const price=Number(row.price),compare=row.compare_at_price===''?0:Number(row.compare_at_price);
    if(!Number.isFinite(price)||price<1||!Number.isSafeInteger(Math.round(price*100)))row.errors.push('Invalid price');
    if(compare>0&&compare<=price)row.errors.push('Previous price must exceed price');
    if(row.product_type==='physical'&&(!/^\d+$/.test(row.stock_qty)||Number(row.stock_qty)<1||Number(row.stock_qty)>100000))row.errors.push('Invalid stock');
    if(row.description.length<10)row.errors.push('Description needs 10+ characters');
    if(row.image_url&&!/^https:\/\//i.test(row.image_url))row.errors.push('Image URL must use HTTPS');
    if(row.product_type==='digital'&&row.digital_delivery_url&&!/^https:\/\//i.test(row.digital_delivery_url))row.errors.push('Digital URL must use HTTPS');
    const sku=row.sku.toLowerCase();if(sku&&seen.has(sku))row.errors.push('Duplicate SKU in file');if(sku)seen.add(sku);
    row.price_kobo=Math.round(price*100);row.compare_at_kobo=compare?Math.round(compare*100):null;
    return row;
  });
}
function renderBulkPreview(){
  const wrap=$('#bulk-preview-wrap'),body=$('#bulk-preview-rows'),button=$('#bulk-submit-button');
  if(!wrap||!body||!button)return;
  wrap.hidden=!bulkImportRows.length;
  body.innerHTML=bulkImportRows.map(r=>'<tr><td>'+r.row_number+'</td><td><strong>'+html(r.name||'—')+'</strong></td><td>'+html(r.category||'—')+'</td><td>'+html(r.product_type)+'</td><td>'+(r.price_kobo?money(r.price_kobo):'—')+'</td><td>'+(r.errors.length?'<span class="status-pill rejected">'+html(r.errors.join('; '))+'</span>':'<span class="status-pill approved">Ready</span>')+'</td></tr>').join('');
  const valid=bulkImportRows.filter(r=>!r.errors.length).length,invalid=bulkImportRows.length-valid;
  button.disabled=valid===0;button.textContent='Submit '+valid+' valid products for review';
  $('#bulk-upload-status').textContent=bulkImportRows.length+' rows found · '+valid+' ready · '+invalid+' need correction. Invalid rows will not be imported.';
}
async function loadBulkCsv(file){
  const status=$('#bulk-upload-status');status.textContent='Reading CSV…';
  if(!file||file.size>200*1024){status.textContent='Choose a CSV file smaller than 200 KB.';return;}
  try{bulkImportRows=validateBulkFile(await file.text());renderBulkPreview();}
  catch(error){bulkImportRows=[];$('#bulk-preview-wrap').hidden=true;status.textContent=error.message;}
}
async function submitBulkProducts(){
  const valid=bulkImportRows.filter(r=>!r.errors.length);if(!valid.length)return;
  const button=$('#bulk-submit-button');button.disabled=true;button.textContent='Submitting products…';
  try{
    const result=await api('seller.products.bulk',{products:valid.map(r=>({row_number:r.row_number,name:r.name,category_id:r.category_id,product_type:r.product_type,price_kobo:r.price_kobo,compare_at_kobo:r.compare_at_kobo,stock_qty:r.stock_qty,sku:r.sku,image_url:r.image_url,description:r.description,digital_delivery_url:r.digital_delivery_url}))});
    notify(result.created_count+' products submitted. They will appear in your store after admin approval.');
    bulkImportRows=[];$('#bulk-product-file').value='';$('#bulk-preview-wrap').hidden=true;await loadDashboardTab();
  }catch(error){$('#bulk-upload-status').textContent=error.message||'Bulk upload failed. Please correct the file and try again.';button.disabled=false;renderBulkPreview();}
}
async function submitProduct(e){
  e.preventDefault();
  const error=$('#product-error');
  const button=$('#product-form button[type=submit]');
  const form=$('#product-form');
  error.textContent='';
  if(!form.reportValidity())return;
  const name=$('#product-name').value.trim();
  const categoryId=$('#product-category').value;
  const type=$('#product-type').value;
  const price=Number($('#product-price').value);
  const compare=Number($('#product-compare').value||0);
  const stock=Number($('#product-stock').value);
  const imageUrl=$('#product-image').value.trim();
  const digitalUrl=$('#digital-url').value.trim();
  if(name.length<3){error.textContent='Enter a product name with at least 3 characters.';$('#product-name').focus();return;}
  let variants=[];
  if(!categoryId){error.textContent='Please choose a product category.';$('#product-category').focus();return;}
  if(!Number.isFinite(price)||price<1){error.textContent='Enter a selling price of at least ₦1.';$('#product-price').focus();return;}
  if(compare>0&&compare<=price){error.textContent='Previous price must be higher than the selling price.';$('#product-compare').focus();return;}
  if(type==='physical'&&!$('#product-variants').value.trim()&&(!Number.isInteger(stock)||stock<1)){error.textContent='Enter a whole-number stock quantity of at least 1.';$('#product-stock').focus();return;}
  if(imageUrl&&!/^https:\/\//i.test(imageUrl)){error.textContent='Product photo URL must begin with https://.';$('#product-image').focus();return;}
  if(type==='digital'&&digitalUrl&&!/^https:\/\//i.test(digitalUrl)){error.textContent='Digital delivery link must begin with https://.';$('#digital-url').focus();return;}
  const variantLines=$('#product-variants').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  for(let i=0;i<variantLines.length;i++){const parts=variantLines[i].split('|').map(x=>x.trim());const vPrice=parts[2]?Number(parts[2]):0,vStock=Number(parts[3]);if(parts.length<3||!parts[0]||!Number.isInteger(vStock)||vStock<0||vStock>100000|| (parts[2]&&(!Number.isFinite(vPrice)||vPrice<1))){error.textContent='Check variation line '+(i+1)+'. Use: Option | SKU | Price (optional) | Stock.';return;}variants.push({name:parts[0],sku:parts[1]||'',price_kobo:vPrice?nairaToKobo(vPrice):null,stock_qty:vStock});}
  if(variants.length>50){error.textContent='A product can have up to 50 variations.';return;}
  const payload={
    id:$('#product-id').value,name,category_id:categoryId,product_type:type,variants,
    price_kobo:nairaToKobo(price),compare_at_kobo:compare?nairaToKobo(compare):null,
    stock_qty:type==='digital'?0:stock,sku:$('#product-sku').value.trim(),
    image_url:imageUrl,description:$('#product-description').value.trim(),digital_delivery_url:digitalUrl
  };
  button.disabled=true;
  button.textContent='Submitting product…';
  try{
    const result=await api('seller.product.save',payload);
    closeModal('product-modal');
    state.dashboardTab='products';
    await loadDashboardTab();
    notify(result?.product?.status==='pending'?'Product submitted. It will appear in your store after approval.':'Product saved successfully.');
  }catch(err){
    error.textContent=err.message||'Product could not be saved. Please try again.';
  }finally{
    button.disabled=false;
    button.innerHTML='Submit product for review <span>→</span>';
  }
}
async function submitAuth(e){
  e.preventDefault();
  $('#auth-error').textContent='';
  const registering = state.authMode === 'register';
  if (registering && $('#auth-password').value !== $('#auth-password-confirm').value) {
    $('#auth-error').textContent = 'Your passwords do not match. Please check and try again.';
    $('#auth-password-confirm').focus();
    return;
  }
  const button=$('#auth-submit');
  button.disabled=true;
  const payload={email:$('#auth-email').value.trim(),password:$('#auth-password').value};
  try{
    if(registering){
      Object.assign(payload,growthPayload());
      payload.full_name=$('#auth-name').value.trim();
      payload.phone=$('#auth-phone').value.trim();
      if (!$('#owner-token-wrap').hidden) payload.owner_token=$('#owner-token').value.trim();
    }
    const data=await api(registering?'auth.register':'auth.login',payload);
    state.user=data.user;
    await refreshSession();
    closeModal('auth-modal');
    notify(registering?'Your ETHAN MARKET account is ready.':'Welcome back.');
    if(state.user&&(['super_admin','admin'].includes(state.user.role)))openDashboard('overview');
    else if(state.user.role==='seller')openDashboard('overview');
    await verifyPaymentFromUrl();
  }catch(err){$('#auth-error').textContent=err.message;}finally{button.disabled=false;}
}
async function refreshSession(){
  try {
    const data=await api('auth.me');
    state.user=data.user||null;
    state.seller=data.seller||null;
  } catch {
    // Keep a user established by a successful login/register if the session
    // refresh has a transient network or database error.
    if(!state.user) state.seller=null;
  }
  if(state.user) await syncWishlist();
  const isAdmin=Boolean(state.user&&['admin','super_admin'].includes(state.user.role));
  const button=$('#account-button');
  if(button){
    button.title=state.user?(isAdmin?'Open your ETHAN MARKET admin dashboard':`Signed in as ${state.user.full_name}`):'Open your ETHAN MARKET account';
    button.setAttribute('aria-label',isAdmin?'Open admin dashboard':state.user?'Open your account':'Account sign in');
    const label=button.querySelector('.action-label');
    if(label) label.textContent=isAdmin?'Admin dashboard':'Account';
  }
  const adminButton=$('#admin-dashboard-button');
  if(adminButton){
    adminButton.hidden=!isAdmin;
    adminButton.setAttribute('aria-label','Open ETHAN MARKET admin dashboard');
  }
  startNotificationPolling();
}
async function previewCheckout() {
  if(!state.user||!state.cart.length)return;
  const panel=$('#checkout-breakdown');
  if(panel)panel.innerHTML='<small>Calculating your delivery estimate…</small>';
  try {
    const result=await api('checkout.preview',{
      items:state.cart.map(x=>({product_id:x.product_id,variant_id:x.variant_id||'',quantity:x.quantity})),
      state:$('#checkout-state').value,city:$('#checkout-city').value,
      code:$('#checkout-promo').value.trim().toUpperCase()
    });
    if(panel)panel.innerHTML=`<div><span>Products subtotal</span><b>${money(result.subtotal_kobo)}</b></div><div><span>Delivery — ${html(result.delivery_zone_name)}</span><b>${money(result.shipping_kobo)}</b></div>${result.discount_kobo?`<div><span>Promo discount</span><b>−${money(result.discount_kobo)}</b></div>`:''}<div><span>Payment processing</span><b>₦0 — covered by Ethan</b></div><div class="checkout-breakdown-total"><span>Total payable</span><b>${money(result.total_kobo)}</b></div>`;
    $('#checkout-total').textContent=money(result.total_kobo);
  } catch(error) { if(panel)panel.innerHTML=`<small class="form-error">${html(error.message)}</small>`; }
}
async function applyCheckoutPromo() {
  const code=$('#checkout-promo').value.trim().toUpperCase();
  const feedback=$('#checkout-promo-feedback');
  if(!code){feedback.textContent='Enter a promo code first.';return;}
  const button=$('#checkout-apply-promo');button.disabled=true;feedback.textContent='Checking promo code…';
  try {
    const result=await api('checkout.preview',{code,items:state.cart.map(x=>({product_id:x.product_id,quantity:x.quantity})),state:$('#checkout-state').value,city:$('#checkout-city').value});
    state.promoPreview=result;
    await previewCheckout();
    feedback.textContent=`${result.promo_code||code} applied — you save ${money(result.discount_kobo)}.`;
  } catch(error) { state.promoPreview=null;$('#checkout-total').textContent=money(cartTotal());feedback.textContent=error.message; }
  finally { button.disabled=false; }
}
async function submitCheckout(e){
  e.preventDefault();$('#checkout-error').textContent='';
  if(!state.config.payments_enabled){$('#checkout-error').textContent='Paystack checkout has not been activated yet. Your cart is saved; please try again later.';return;}
  const button=$('#checkout-form button[type=submit]');button.disabled=true;
  const payload={...growthPayload(),items:state.cart.map(x=>({product_id:x.product_id,quantity:x.quantity})),promo_code:$('#checkout-promo').value.trim().toUpperCase(),recipient_name:$('#checkout-recipient').value,phone:$('#checkout-phone').value,address_line1:$('#checkout-address').value,city:$('#checkout-city').value,state:$('#checkout-state').value,postal_code:$('#checkout-postal').value,buyer_note:$('#checkout-note').value};
  try{const result=await api('checkout.create',payload);window.location.href=result.authorization_url;}
  catch(err){$('#checkout-error').textContent=err.message;button.disabled=false;}
}
async function verifyPaymentFromUrl(){
  const params=new URLSearchParams(location.search);if(params.get('payment')!=='verify')return;
  const reference=params.get('reference');
  if(!reference){notify('No payment reference was returned.');return;}
  if(!state.user){openAuth('login','Sign in with the account used for this order to confirm the payment.');return;}
  try{const result=await api('payment.verify',{reference});state.cart=[];saveCart();renderCart();history.replaceState({},'',location.pathname);notify(`Payment confirmed. Order ${result.order.order_number} is paid.`);openDashboard('orders');}
  catch(e){notify(e.message);history.replaceState({},'',location.pathname);}
}
async function logout(){try{await api('auth.logout');}catch{}if(state.notificationTimer)clearInterval(state.notificationTimer);state.notificationTimer=null;state.notificationTopId=null;state.unreadNotifications=0;state.user=null;state.seller=null;state.wishlist.clear();updateNotificationBadge();closeModal('dashboard-modal');notify('You have signed out.');}
async function adminAction(el){
  const action=el.dataset.adminAction;const id=el.dataset.id;const status=el.dataset.status;let payload={id,status};
  if(action==='product-status' && el.dataset.featured) payload.featured=el.dataset.featured==='true';
  if(action==='payout-status'&&status==='paid') {const ref=prompt('Enter the bank transfer / Paystack payout reference. Do not mark this paid until the transfer has cleared.');if(ref===null)return;payload.payout_reference=ref.trim();if(!payload.payout_reference){notify('A payout reference is required.');return;}}
  el.disabled=true;
  try{await api('admin.'+action,payload);notify('Marketplace record updated.');loadDashboardTab();}
  catch(e){notify(e.message);el.disabled=false;}
}
async function adminConfirmDeliveryAction(el){
  const evidence=prompt('Enter the verified courier tracking result, proof-of-delivery reference or other delivery evidence (minimum 5 characters):');
  if(evidence===null)return;
  if(evidence.trim().length<5){notify('Delivery evidence is required.');return;}
  if(!confirm('Confirm that you checked the evidence and the physical item has been delivered? This begins the 7-day seller protection window.'))return;
  el.disabled=true;
  try{
    const result=await api('admin.confirm-delivery',{order_item_id:el.dataset.adminConfirmDelivery,evidence:evidence.trim()});
    notify('Delivery verification recorded. Seller payout becomes eligible after '+result.eligible_in_days+' days, unless a dispute is opened.');
    loadDashboardTab();
  }catch(error){notify(error.message);el.disabled=false;}
}
async function confirmDeliveryAction(el){
  if(!confirm('Confirm that this item has physically arrived and is in your possession? This starts the seller payout protection period.')) return;
  el.disabled=true;
  try {
    const result=await api('buyer.confirm-delivery',{order_item_id:el.dataset.confirmDelivery});
    notify('Receipt confirmed. Seller payout remains protected for '+result.eligible_in_days+' days.');
    loadDashboardTab();
  } catch(error) { notify(error.message); el.disabled=false; }
}
async function openDisputeAction(el){
  const reasons=['item_not_received','damaged','not_as_described','wrong_item','digital_access','other'];
  const reason=prompt('Enter one reason: '+reasons.join(', '),'not_as_described');
  if(reason===null)return;
  if(!reasons.includes(reason.trim())){notify('Please choose one of the listed reasons.');return;}
  const details=prompt('Describe the problem in at least 20 characters:');
  if(details===null)return;
  el.disabled=true;
  try {
    await api('buyer.open-dispute',{order_item_id:el.dataset.openDispute,reason:reason.trim(),details});
    notify('Your case has been opened. Any unpaid seller payout is now blocked while the case is reviewed.');
    loadDashboardTab();
  } catch(error){notify(error.message);el.disabled=false;}
}
async function respondDisputeAction(el){
  const response=prompt('Reply with your evidence, tracking details or resolution proposal (at least 10 characters):');
  if(response===null)return;
  el.disabled=true;
  try { await api('seller.respond-dispute',{dispute_id:el.dataset.respondDispute,response}); notify('Your response has been sent to marketplace administration.'); loadDashboardTab(); }
  catch(error){notify(error.message);el.disabled=false;}
}
async function resolveDisputeAction(el){
  const outcome=el.dataset.outcome;
  const notes=prompt('Resolution notes (at least 10 characters):');
  if(notes===null)return;
  let refund_reference='';
  if(outcome==='buyer'){
    refund_reference=prompt('Complete the refund in the payment provider dashboard first, then enter its refund reference here:')||'';
    if(!refund_reference){notify('A completed refund reference is required.');return;}
  }
  if(!confirm(outcome==='seller'?'Resolve this case in the seller’s favour and make the payout eligible for admin approval?':'Confirm that the buyer refund has been completed and record this case as resolved?'))return;
  el.disabled=true;
  try { await api('admin.dispute-resolve',{dispute_id:el.dataset.disputeResolve,outcome,notes,refund_reference}); notify('Dispute resolution recorded.'); loadDashboardTab(); }
  catch(error){notify(error.message);el.disabled=false;}
}

async function sellerFulfillAction(el){
  let tracking_number='',tracking_carrier='';
  if(el.dataset.status==='dispatched'){tracking_carrier=prompt('Delivery company / courier (optional):')||'';tracking_number=prompt('Tracking number / waybill number (optional):')||'';}
  el.disabled=true;
  try{await api('seller.fulfill',{order_item_id:el.dataset.fulfill,status:el.dataset.status,tracking_number,tracking_carrier});notify('Order fulfilment updated.');loadDashboardTab();}
  catch(e){notify(e.message);el.disabled=false;}
}

// Global interaction handling uses delegation so freshly-rendered dashboard rows remain active.
document.addEventListener('click',async e=>{
  const close=e.target.closest('[data-close]');if(close){closeModal(close.dataset.close);return;}
  const category=e.target.closest('[data-category]');if(category){selectCategory(category.dataset.category);return;}
  const add=e.target.closest('[data-add]');if(add){const p=state.products.find(x=>x.id===add.dataset.add);if(p?.variants?.length)showProduct(add.dataset.add);else addToCart(add.dataset.add);return;}
  const detailAdd=e.target.closest('[data-detail-add]');if(detailAdd){const variantId=$('#detail-variant')?.value||'';if(state.currentProduct?.variants?.length&&!variantId){notify('Choose an available option first.');return;}addToCart(detailAdd.dataset.detailAdd,variantId);closeModal('detail-modal');return;}
  const view=e.target.closest('[data-view]');if(view){showProduct(view.dataset.view);return;}
  const store=e.target.closest('[data-store]');if(store){showStore(store.dataset.store);return;}
  const review=e.target.closest('[data-review]');if(review){const rating=Number(prompt('Rate this item from 1 to 5 stars:','5'));if(!Number.isInteger(rating)||rating<1||rating>5){notify('Enter a rating from 1 to 5.');return;}const reviewText=prompt('Write a short review (optional):','')||'';try{await api('reviews.create',{product_id:review.dataset.review,order_id:review.dataset.order,rating,review_text:reviewText});notify('Thank you. Your review has been submitted.');}catch(err){notify(err.message);}return;}
  const wish=e.target.closest('[data-wish]');if(wish){toggleWishlist(wish.dataset.wish);return;}
  const qty=e.target.closest('[data-qty]');if(qty){changeQuantity(qty.dataset.qty,Number(qty.dataset.delta),qty.dataset.variant||'');return;}
  const authMode=e.target.closest('[data-auth-mode]');if(authMode){setAuthMode(authMode.dataset.authMode);return;}
  const dashTab=e.target.closest('[data-dash-tab]');if(dashTab){state.dashboardTab=dashTab.dataset.dashTab;loadDashboardTab();return;}
  const notificationOpen=e.target.closest('[data-notification-open]');if(notificationOpen){openNotificationAction(notificationOpen);return;}
  if(e.target.closest('#notifications-mark-all')){markAllNotificationsRead();return;}
  const share=e.target.closest('[data-share-url]');
  if(share){
    const url=share.dataset.shareUrl||'';
    const message=share.dataset.shareText||'Discover ETHAN MARKET';
    const payload=message+(url&&!message.includes(url)?' '+url:'');
    if(share.dataset.shareChannel==='whatsapp'){window.open('https://wa.me/?text='+encodeURIComponent(payload),'_blank','noopener,noreferrer');return;}
    if(navigator.share){
      try{await navigator.share({title:'ETHAN MARKET',text:message,url});}
      catch(error){if(error.name!=='AbortError')notify('Sharing was not available. Copy the link instead.');}
    } else {
      try{await navigator.clipboard.writeText(payload);notify('ETHAN MARKET message copied.');}
      catch{prompt('Copy this ETHAN MARKET message:',payload);}
    }
    return;
  }
  const marketingCopy=e.target.closest('[data-marketing-copy]');
  if(marketingCopy){
    const message=marketingCopyMessage(marketingCopy.dataset.marketingCopy);
    try{await navigator.clipboard.writeText(message);notify('Marketing message copied.');}
    catch{prompt('Copy this marketing message:',message);}
    return;
  }
  const growthCopy=e.target.closest('[data-growth-copy]');if(growthCopy){try{await navigator.clipboard.writeText(growthCopy.dataset.growthCopy);notify('ETHAN MARKET link copied.');}catch{prompt('Copy your ETHAN MARKET link:',growthCopy.dataset.growthCopy);}return;}
  if(e.target.closest('#affiliate-apply')){try{const r=await api('growth.affiliate-apply');notify(r.status==='pending'?'Affiliate application submitted for review.':'You are already approved.');loadDashboardTab();}catch(error){notify(error.message);}return;}
  const campaignStatus=e.target.closest('[data-growth-campaign-status]');if(campaignStatus){try{await api('admin.growth-campaign-status',{id:campaignStatus.dataset.growthCampaignStatus,status:campaignStatus.dataset.status});notify('Campaign updated.');loadDashboardTab();}catch(error){notify(error.message);}return;}
  const promoStatus=e.target.closest('[data-growth-promo-status]');if(promoStatus){try{await api('admin.growth-promo-status',{id:promoStatus.dataset.growthPromoStatus,active:promoStatus.dataset.active==='true'});notify('Promo code updated.');loadDashboardTab();}catch(error){notify(error.message);}return;}
  const affiliate=e.target.closest('[data-growth-affiliate]');if(affiliate){const rate=$('[data-affiliate-rate="'+affiliate.dataset.growthAffiliate+'"]');const bps=affiliate.dataset.status==='approved'?Math.round(Number(rate?.value||0)*100):0;if(affiliate.dataset.status==='approved'&&bps<1){notify('Set a marketplace-fee share above zero before approving.');return;}try{await api('admin.affiliate-status',{user_id:affiliate.dataset.growthAffiliate,status:affiliate.dataset.status,commission_share_bps:bps});notify('Affiliate status updated.');loadDashboardTab();}catch(error){notify(error.message);}return;}
  const affiliateConversion=e.target.closest('[data-affiliate-conversion]');if(affiliateConversion){let payout_reference='';if(affiliateConversion.dataset.status==='paid'){payout_reference=prompt('Enter the cleared bank transfer reference for this affiliate reward:')||'';if(!payout_reference.trim()){notify('A payout reference is required.');return;}}try{await api('admin.affiliate-conversion',{id:affiliateConversion.dataset.affiliateConversion,status:affiliateConversion.dataset.status,payout_reference});notify('Affiliate conversion updated.');loadDashboardTab();}catch(error){notify(error.message);}return;}
  const action=e.target.closest('[data-admin-action]');if(action){adminAction(action);return;}
  const fulfill=e.target.closest('[data-fulfill]');if(fulfill){sellerFulfillAction(fulfill);return;}
  const adminConfirmDelivery=e.target.closest('[data-admin-confirm-delivery]');if(adminConfirmDelivery){adminConfirmDeliveryAction(adminConfirmDelivery);return;}
  const confirmDelivery=e.target.closest('[data-confirm-delivery]');if(confirmDelivery){confirmDeliveryAction(confirmDelivery);return;}
  const openDispute=e.target.closest('[data-open-dispute]');if(openDispute){openDisputeAction(openDispute);return;}
  const respondDispute=e.target.closest('[data-respond-dispute]');if(respondDispute){respondDisputeAction(respondDispute);return;}
  const resolveDispute=e.target.closest('[data-dispute-resolve]');if(resolveDispute){resolveDisputeAction(resolveDispute);return;}
  const edit=e.target.closest('[data-edit-product]');if(edit){const product=(state.sellerData?.products||[]).find(p=>p.id===edit.dataset.editProduct);if(product)openProductEditor(product);return;}
  if(e.target.closest('#open-cart')){openCart();return;}
  if(e.target.closest('#close-cart')||e.target===$('#drawer-backdrop')){closeCart();return;}
  if(e.target.closest('#admin-dashboard-button')){e.preventDefault();if(state.user)openDashboard('overview');return;}
  if(e.target.closest('#account-button')){if(state.user){e.preventDefault();openDashboard();}return;}
  if(e.target.closest('#seller-cta')){openSellerApplication();return;}
  if(e.target.closest('#checkout-button')){openCheckout();return;}
  if(e.target.closest('#logout-button')){logout();return;}
  if(e.target.closest('#add-product-button')){openProductEditor();return;}
  if(e.target.closest('#dashboard-apply-seller')){closeModal('dashboard-modal');openSellerApplication();return;}
  if(e.target.closest('#dashboard-retry')){loadDashboardTab();return;}
  if(e.target.closest('#clear-filters')){state.category='all';state.filter='all';state.query='';$('#search-input').value='';$$('.filter-chip').forEach(b=>b.classList.toggle('selected',b.dataset.filter==='all'));renderCategories();loadProducts();return;}
  if(e.target.closest('#mobile-menu')){const nav=$('#main-nav');const open=nav.classList.toggle('open');$('#mobile-menu').setAttribute('aria-expanded',String(open));return;}
  if(e.target.classList.contains('modal-backdrop') && !e.target.hidden){closeModal(e.target.id);return;}
});

$('#search-form').addEventListener('submit',e=>{e.preventDefault();state.query=$('#search-input').value.trim();state.category='all';renderCategories();loadProducts();$('#shop').scrollIntoView({behavior:'smooth'});});
$('#search-input').addEventListener('input',e=>{if(!e.target.value){state.query='';loadProducts();}});
$('#filter-chips').addEventListener('click',e=>{const btn=e.target.closest('[data-filter]');if(btn)setFilter(btn.dataset.filter);});
$('#sort-select').addEventListener('change',e=>{state.sort=e.target.value;loadProducts();});
$('#auth-form').addEventListener('submit',submitAuth);
$('#auth-email').addEventListener('input',updateOwnerTokenVisibility);
$('#seller-form').addEventListener('submit',submitSellerApplication);
$('#product-form').addEventListener('submit',submitProduct);
$('#dashboard-content').addEventListener('change',e=>{if(e.target.id==='bulk-product-file')loadBulkCsv(e.target.files?.[0]);});
$('#dashboard-content').addEventListener('click',e=>{
  if(e.target.closest('#bulk-template-download')){downloadBulkTemplate();return;}
  if(e.target.closest('#bulk-submit-button')){submitBulkProducts();return;}
  if(e.target.closest('#bulk-clear-button')){bulkImportRows=[];$('#bulk-product-file').value='';$('#bulk-preview-wrap').hidden=true;$('#bulk-upload-status').textContent='CSV only · Maximum 100 products per upload.';}
});
$('#product-type').addEventListener('change',updateProductType);
$('#product-variants').addEventListener('input',updateProductType);
$('#product-image-file').addEventListener('change',uploadProductImage);
$('#product-image').addEventListener('input',e=>renderProductImagePreview(e.target.value));
$('#product-image-clear').addEventListener('click',()=>{
  $('#product-image').value='';
  $('#product-image-file').value='';
  $('#image-upload-state').textContent='Photo removed. You can upload another image.';
  renderProductImagePreview('');
});
$('#checkout-form').addEventListener('submit',submitCheckout);
$('#checkout-apply-promo').addEventListener('click',applyCheckoutPromo);
$('#checkout-city').addEventListener('change',previewCheckout);
$('#checkout-state').addEventListener('change',previewCheckout);
$('#dashboard-content').addEventListener('submit',async e=>{
  if(e.target.id==='growth-campaign-form'){
    e.preventDefault();$('#growth-campaign-error').textContent='';
    try{await api('admin.growth-campaign-save',{name:$('#growth-campaign-name').value,slug:$('#growth-campaign-slug').value,source:$('#growth-campaign-source').value,medium:$('#growth-campaign-medium').value,budget_kobo:nairaToKobo($('#growth-campaign-budget').value)});notify('Campaign created. Open Growth to copy its tracking link.');loadDashboardTab();}
    catch(error){$('#growth-campaign-error').textContent=error.message;}
  }
  if(e.target.id==='growth-promo-form'){
    e.preventDefault();$('#growth-promo-error').textContent='';
    try{await api('admin.growth-promo-save',{code:$('#growth-promo-code').value,discount_bps:Math.round(Number($('#growth-promo-discount').value)*100),max_discount_kobo:nairaToKobo($('#growth-promo-cap').value),min_subtotal_kobo:nairaToKobo($('#growth-promo-minimum').value),max_redemptions:Number($('#growth-promo-uses').value)||null});notify('Promo code created.');loadDashboardTab();}
    catch(error){$('#growth-promo-error').textContent=error.message;}
  }
  if(e.target.id==='store-settings-form'){
    e.preventDefault();$('#store-settings-error').textContent='';
    try{const data=await api('seller.profile',{description:$('#profile-description').value,phone:$('#profile-phone').value,whatsapp:$('#profile-whatsapp').value,city:$('#profile-city').value,state:$('#profile-state').value,bank_name:$('#profile-bank').value,bank_code:$('#profile-bank-code').value,account_number:$('#profile-account').value,account_name:$('#profile-account-name').value});state.seller=data.seller;notify('Store profile saved.');}
    catch(err){$('#store-settings-error').textContent=err.message;}
  }
  if(e.target.id==='market-settings-form'){
    e.preventDefault();$('#market-settings-error').textContent='';
    try{const data=await api('admin.settings',{commission_bps:Math.round(Number($('#market-commission').value)*100),seller_payout_hold_days:Number($('#market-hold-days').value)});state.config.commission_bps=Number(data.settings.commission_bps||500);notify('Marketplace settings saved.');}
    catch(err){$('#market-settings-error').textContent=err.message;}
  }
  if(e.target.id==='delivery-zone-form'){
    e.preventDefault();$('#delivery-zone-error').textContent='';
    try{
      await api('admin.delivery-zone-save',{id:$('#delivery-zone-id').value||'',name:$('#delivery-zone-name').value,state:$('#delivery-zone-state').value,city:$('#delivery-zone-city').value,fee_kobo:nairaToKobo($('#delivery-zone-fee').value)});
      notify('Delivery zone saved.');loadDashboardTab();
    }catch(err){$('#delivery-zone-error').textContent=err.message;}
  }
});
$('#dashboard-content').addEventListener('change',async e=>{
  if(e.target.matches('[data-order-status]')&&e.target.value){try{await api('admin.order-status',{id:e.target.dataset.orderStatus,status:e.target.value});notify('Order status updated.');loadDashboardTab();}catch(err){notify(err.message);}}
});
$('#dashboard-content').addEventListener('click',async e=>{
  const edit=e.target.closest('[data-zone-edit]');
  if(edit){
    $('#delivery-zone-id').value=edit.dataset.zoneEdit;
    $('#delivery-zone-name').value=edit.dataset.zoneName;
    $('#delivery-zone-state').value=edit.dataset.zoneState;
    $('#delivery-zone-city').value=edit.dataset.zoneCity;
    $('#delivery-zone-fee').value=Number(edit.dataset.zoneFee)/100;
    $('#delivery-zone-form').scrollIntoView({behavior:'smooth',block:'center'});
    return;
  }
  const toggle=e.target.closest('[data-zone-toggle]');
  if(toggle){
    toggle.disabled=true;
    try{await api('admin.delivery-zone-status',{id:toggle.dataset.zoneToggle,active:toggle.dataset.active==='true'});notify('Delivery zone status updated.');loadDashboardTab();}
    catch(err){notify(err.message);toggle.disabled=false;}
  }
  if(e.target.id==='delivery-zone-reset'){
    $('#delivery-zone-form').reset();$('#delivery-zone-id').value='';$('#delivery-zone-state').value='Lagos';$('#delivery-zone-city').value='*';$('#delivery-zone-error').textContent='';
  }
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)pollNotifications(true);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeCart();$('.modal-backdrop').filter(m=>!m.hidden).forEach(m=>closeModal(m.id));}});
$('#year').textContent=new Date().getFullYear();

async function start() {
  captureGrowthAttribution();
  trackGrowthEvent('page_view');
  // Open registration immediately. Do not make visitors wait for catalogue
  // or database requests before they can see the account form.
  const params = new URLSearchParams(location.search);
  const directRegistration =
    location.pathname === '/register' ||
    location.pathname === '/register/' ||
    params.get('auth') === 'register';
  const requestAdminDashboard = params.get('dashboard') === 'admin';
  if (directRegistration) openAuth('register');

  // Resolve the signed-in role before loading the public catalogue. This ensures
  // the owner dashboard is not blocked by a slow categories/products request.
  await refreshSession();
  renderCart();

  if (directRegistration && state.user) {
    closeModal('auth-modal');
    openDashboard('overview');
  }
  if (requestAdminDashboard) {
    history.replaceState({}, '', location.pathname + location.hash);
    if (state.user && ['admin','super_admin'].includes(state.user.role)) openDashboard('overview');
    else notify('Sign in with an authorised marketplace administrator account.');
  }

  // Public shopping data can load after the account workspace is already available.
  await initPublicData();
  await hydrateCart();
  await verifyPaymentFromUrl();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js?v=20261121-account-dashboard-v2', { updateViaCache: 'none' }).catch(() => {});
  }
}
start();
