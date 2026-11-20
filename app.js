'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  user: null, seller: null, categories: [], products: [], config: { shipping_kobo: 200000, payments_enabled: false },
  category: 'all', filter: 'all', query: '', sort: 'featured', cart: readCart(), wishlist: new Set(),
  authMode: 'login', dashboardTab: 'overview', sellerData: null, adminData: {}, currentProduct: null, toastTimer: null
};
const money = kobo => '₦' + (Number(kobo || 0) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
const nairaToKobo = value => Math.max(0, Math.round(Number(value || 0) * 100));
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const textStatus = value => String(value || '').replaceAll('_',' ');
const escAttr = value => html(value).replace(/`/g, '&#96;');

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
  $('.auth-tab').forEach(b => b.classList.toggle('active', b.dataset.authMode === mode));
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
function cartProducts() { return state.cart.map(item => ({ ...item, product: state.products.find(p => p.id === item.product_id) })).filter(item => item.product); }
function cartCount() { return state.cart.reduce((sum, item) => sum + Number(item.quantity || 0), 0); }
function cartSubtotal() { return cartProducts().reduce((sum, item) => sum + Number(item.product.price_kobo) * item.quantity, 0); }
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
      <div class="product-info"><span class="product-category">${html(p.category_name || 'Marketplace')}</span><h3>${html(p.name)}</h3><span class="seller-name">Sold by <button class="store-link" type="button" data-store="${escAttr(p.store_slug || '')}">${html(p.store_name || 'Ethan seller')}</button></span>
        <div class="product-bottom"><strong class="product-price">${money(p.price_kobo)} ${p.compare_at_kobo ? `<s>${money(p.compare_at_kobo)}</s>` : ''}</strong><span class="product-rating">${Number(p.rating || 0) ? `<strong>★</strong> ${Number(p.rating).toFixed(1)}` : 'New'}${Number(p.review_count || 0) ? ` (${p.review_count})` : ''}</span></div>
        <div class="product-card-actions"><button class="add-button" data-add="${escAttr(p.id)}" ${p.product_type==='physical'&&Number(p.stock_qty)<1?'disabled':''}>${p.product_type==='physical'&&Number(p.stock_qty)<1?'Out of stock':'Add to bag +'}</button><button class="view-button" data-view="${escAttr(p.id)}">View</button></div>
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
  $('#cart-items').innerHTML = entries.length ? entries.map(({product:p,quantity}) => `
    <div class="cart-line"><div class="cart-thumb">${/^https:\/\//i.test(p.image_url || '') ? `<img src="${escAttr(p.image_url)}" alt="">` : '✧'}</div>
      <div><strong>${html(p.name)}</strong><small>${money(p.price_kobo)} each · ${p.product_type === 'digital' ? 'Digital' : 'Physical'}</small><div class="quantity-control"><button data-qty="${escAttr(p.id)}" data-delta="-1" aria-label="Decrease quantity">−</button><span>${quantity}</span><button data-qty="${escAttr(p.id)}" data-delta="1" aria-label="Increase quantity">＋</button></div></div>
      <strong class="cart-line-price">${money(Number(p.price_kobo)*quantity)}</strong></div>`).join('') : `<div class="cart-empty"><span>▢</span><b>Your bag is empty.</b><p>Start exploring and add something you love.</p></div>`;
}
async function addToCart(productId) {
  let product = state.products.find(p => p.id === productId);
  if (!product) {
    try { const result = await api('products.detail', { id: productId }); product = result.product; state.products.push(product); }
    catch (e) { notify(e.message || 'This product is no longer available.'); return; }
  }
  const row = state.cart.find(x => x.product_id === productId);
  const maxQuantity = product.product_type === 'physical' ? Math.max(0, Number(product.stock_qty || 0)) : 20;
  if (maxQuantity < 1) { notify('This product is currently out of stock.'); return; }
  if (row) { if (Number(row.quantity) >= maxQuantity) { notify('You have reached the available stock for this item.'); return; } row.quantity = Math.min(maxQuantity, Number(row.quantity) + 1); } else state.cart.push({ product_id: productId, quantity: 1 });
  saveCart(); renderCart(); notify('Added to your shopping bag.');
}
async function hydrateCart() {
  const missing = state.cart.map(x => x.product_id).filter(id => !state.products.some(p => p.id === id));
  await Promise.all(missing.map(async id => {
    try { const result = await api('products.detail', { id }); if (result.product) state.products.push(result.product); }
    catch { state.cart = state.cart.filter(x => x.product_id !== id); saveCart(); }
  }));
}
function changeQuantity(productId, delta) {
  const item = state.cart.find(x => x.product_id === productId); if (!item) return;
  item.quantity += delta; if (item.quantity <= 0) state.cart = state.cart.filter(x => x.product_id !== productId);
  saveCart(); renderCart();
}
async function syncWishlist() {
  if (!state.user) return;
  try { const data = await api('wishlist.list'); state.wishlist = new Set((data.products || []).map(p => p.id)); renderProducts(); } catch {}
}
async function toggleWishlist(productId) {
  if (!state.user) { openAuth('login','Sign in to save items to your wishlist.'); return; }
  try { const result = await api('wishlist.toggle',{product_id:productId}); if(result.saved) state.wishlist.add(productId); else state.wishlist.delete(productId); renderProducts(); notify(result.saved ? 'Saved to your wishlist.' : 'Removed from wishlist.'); }
  catch(e) { notify(e.message); }
}
async function showProduct(productId) {
  try {
    const found = state.products.find(p => p.id === productId);
    if (!found) return;
    const data = await api('products.detail',{id:productId}); const p = data.product; state.currentProduct = p;
    $('#detail-content').innerHTML = `<div class="detail-layout"><div class="detail-image">${/^https:\/\//i.test(p.image_url||'')?`<img src="${escAttr(p.image_url)}" alt="${escAttr(p.name)}">`:'✧'}</div><div class="detail-copy"><span class="product-category">${html(p.category_name||'Marketplace')}</span><h2 id="detail-name">${html(p.name)}</h2><div class="detail-store">Sold by <button class="store-link" type="button" data-store="${escAttr(p.store_slug || '')}">${html(p.store_name)}</button> · ${html([p.city,p.state].filter(Boolean).join(', '))}</div><div class="detail-price">${money(p.price_kobo)}</div><div class="detail-meta"><span>${p.product_type==='digital'?'Digital delivery':'Physical product'}</span><span>${Number(p.stock_qty)>0?'In stock':'Check availability'}</span></div><p>${html(p.description)}</p><div class="detail-actions"><button class="button button-primary" data-detail-add="${escAttr(p.id)}" ${p.product_type==='physical'&&Number(p.stock_qty)<1?'disabled':''}>${p.product_type==='physical'&&Number(p.stock_qty)<1?'Out of stock':'Add to bag <span>＋</span>'}</button><button class="button button-outline" data-wish="${escAttr(p.id)}">♡ Save</button></div></div></div>`;
    showModal('detail-modal');
  } catch(e) { notify(e.message); }
}
async function showStore(slug) {
  if (!slug) return;
  try {
    const data = await api('store.detail', { slug });
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
  $('#checkout-error').textContent = '';
  closeCart(); showModal('checkout-modal');
}
function formatDate(value) { try { return new Intl.DateTimeFormat('en-NG',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(value)); } catch { return value || '—'; } }
function statusPill(value) { const text = textStatus(value); return `<span class="status-pill ${html(value)}">${html(text)}</span>`; }
function tableEmpty(message, columns = 1) { return `<tr><td colspan="${columns}" class="dash-empty">${html(message)}</td></tr>`; }
function openDashboard(tab) {
  if (!state.user) { openAuth('login'); return; }
  const role = state.user.role;
  const tabs = role === 'super_admin' || role === 'admin' ? [
    ['overview','Overview'],['sellers','Sellers'],['products','Products'],['orders','Orders'],['payouts','Payouts'],['settings','Settings']
  ] : role === 'seller' ? [['overview','Overview'],['products','Products'],['orders','Orders'],['payouts','Payouts'],['store','Store settings']] : [['orders','My orders'],['wishlist','Wishlist'],['sell','Become a seller']];
  state.dashboardTabs = tabs;
  state.dashboardTab = tab || tabs[0][0];
  $('#dashboard-title').textContent = role === 'super_admin' || role === 'admin' ? 'Marketplace control.' : role === 'seller' ? 'Seller studio.' : 'Your account.';
  renderDashboardTabs(); showModal('dashboard-modal'); loadDashboardTab();
}
function renderDashboardTabs() {
  $('#dashboard-tabs').innerHTML = state.dashboardTabs.map(([id,label])=>`<button class="dashboard-tab ${state.dashboardTab===id?'active':''}" data-dash-tab="${id}">${label}</button>`).join('');
}
async function loadDashboardTab() {
  renderDashboardTabs();
  const el = $('#dashboard-content'); el.innerHTML = '<div class="dashboard-loading">Loading your workspace…</div>';
  const tab = state.dashboardTab;
  try {
    if (state.user.role === 'super_admin' || state.user.role === 'admin') {
      const data = tab === 'overview' ? await api('admin.overview') : tab === 'settings' ? await api('admin.list',{kind:'settings'}) : await api('admin.list',{kind:tab});
      state.adminData[tab] = data; renderAdminTab(tab,data); return;
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
function renderMetric(label,value) { return `<div class="metric-card"><small>${html(label)}</small><b>${html(value)}</b></div>`; }
function renderAdminTab(tab,data) {
  const el=$('#dashboard-content');
  if(tab==='overview') {
    el.innerHTML=`<div class="metric-grid">${renderMetric('Paid GMV',money(data.orders?.gmv))}${renderMetric('Paid orders',data.orders?.paid_orders||0)}${renderMetric('Approved stores',data.sellers?.approved||0)}${renderMetric('Pending payouts',money(data.payouts?.outstanding))}</div>
      <div class="dash-panel"><h3>Recent orders</h3><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Order</th><th>Buyer</th><th>Total</th><th>Payment</th><th>Created</th></tr></thead><tbody>${(data.recent||[]).map(o=>`<tr><td><strong>${html(o.order_number)}</strong></td><td>${html(o.buyer_email)}</td><td>${money(o.total_kobo)}</td><td>${statusPill(o.payment_status)}</td><td>${formatDate(o.created_at)}</td></tr>`).join('')||tableEmpty('No orders yet.',5)}</tbody></table></div></div>`;
  } else if(tab==='sellers') {
    el.innerHTML=`<div class="dash-panel"><h3>Seller applications and stores</h3><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Store</th><th>Owner</th><th>Location</th><th>Status</th><th>Actions</th></tr></thead><tbody>${(data.sellers||[]).map(s=>`<tr><td><strong>${html(s.store_name)}</strong><br><small>${html(s.slug)}</small></td><td>${html(s.user_name)}<br>${html(s.email)}</td><td>${html([s.city,s.state].filter(Boolean).join(', ')||'—')}</td><td>${statusPill(s.seller_status)}</td><td><div class="dash-actions">${s.seller_status!=='approved'?`<button class="dash-action primary" data-admin-action="seller-status" data-id="${s.id}" data-status="approved">Approve</button>`:''}${s.seller_status!=='rejected'?`<button class="dash-action danger" data-admin-action="seller-status" data-id="${s.id}" data-status="rejected">Reject</button>`:''}${s.seller_status==='approved'?`<button class="dash-action" data-admin-action="seller-status" data-id="${s.id}" data-status="suspended">Suspend</button>`:''}</div></td></tr>`).join('')||tableEmpty('No seller applications yet.',5)}</tbody></table></div></div>`;
  } else if(tab==='products') {
    el.innerHTML=`<div class="dash-panel"><h3>Product review queue</h3><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Product</th><th>Store</th><th>Price</th><th>Stock</th><th>Status</th><th>Actions</th></tr></thead><tbody>${(data.products||[]).map(p=>`<tr><td><strong>${html(p.name)}</strong><br><small>${html(p.category_name||p.product_type)}</small></td><td>${html(p.store_name)}</td><td>${money(p.price_kobo)}</td><td>${p.product_type==='digital'?'Digital':p.stock_qty}</td><td>${statusPill(p.status)}</td><td><div class="dash-actions">${p.status!=='active'?`<button class="dash-action primary" data-admin-action="product-status" data-id="${p.id}" data-status="active">Approve</button>`:''}${p.status!=='rejected'?`<button class="dash-action danger" data-admin-action="product-status" data-id="${p.id}" data-status="rejected">Reject</button>`:''}${p.status==='active'?`<button class="dash-action" data-admin-action="product-status" data-id="${p.id}" data-status="active" data-featured="${p.featured?'false':'true'}">${p.featured?'Unfeature':'Feature'}</button>`:''}</div></td></tr>`).join('')||tableEmpty('No products have been submitted.',6)}</tbody></table></div></div>`;
  } else if(tab==='orders') {
    el.innerHTML=`<div class="dash-panel"><h3>All marketplace orders</h3><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Order</th><th>Buyer</th><th>Amount</th><th>Payment</th><th>Fulfilment</th><th>Update</th></tr></thead><tbody>${(data.orders||[]).map(o=>`<tr><td><strong>${html(o.order_number)}</strong><br><small>${formatDate(o.created_at)}</small></td><td>${html(o.recipient_name)}<br>${html(o.buyer_email)}</td><td>${money(o.total_kobo)}</td><td>${statusPill(o.payment_status)}</td><td>${statusPill(o.status)}</td><td><select class="dash-action" data-order-status="${o.id}"><option value="">Change…</option>${['processing','dispatched','delivered','cancelled'].map(x=>`<option value="${x}">${textStatus(x)}</option>`).join('')}</select></td></tr>`).join('')||tableEmpty('No orders yet.',6)}</tbody></table></div></div>`;
  } else if(tab==='payouts') {
    el.innerHTML=`<div class="dash-panel"><h3>Seller settlement ledger</h3><p class="modal-intro">Record bank settlements with their external transfer reference. Mark a payout as paid only after the transfer has cleared.</p><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Seller / order</th><th>Settlement account</th><th>Gross</th><th>Commission</th><th>Net payable</th><th>Status</th><th>Record payout</th></tr></thead><tbody>${(data.payouts||[]).map(p=>`<tr><td><strong>${html(p.store_name)}</strong><br><small>${html(p.order_number)} · ${html(p.email)}</small></td><td><strong>${html(p.bank_name||'Bank not supplied')}</strong><br><small>${html(p.account_name||'')} · ${html(p.account_number||'')}</small></td><td>${money(p.gross_kobo)}</td><td>${money(p.commission_kobo)}</td><td>${money(p.net_kobo)}</td><td>${statusPill(p.status)}${p.payout_reference?`<br><small>${html(p.payout_reference)}</small>`:''}</td><td><div class="dash-actions">${p.status==='pending'?`<button class="dash-action" data-admin-action="payout-status" data-id="${p.id}" data-status="approved">Approve</button>`:''}${p.status==='approved'?`<button class="dash-action primary" data-admin-action="payout-status" data-id="${p.id}" data-status="paid">Mark paid</button>`:''}</div></td></tr>`).join('')||tableEmpty('No settlement records yet.',7)}</tbody></table></div></div>`;
  } else if(tab==='settings') {
    const settings=data.settings||{};
    el.innerHTML=`<div class="dash-panel"><h3>Marketplace settings</h3><form class="dash-form" id="market-settings-form"><div class="form-field"><label for="market-commission">Default seller commission (%)</label><input id="market-commission" type="number" min="0" max="50" step="0.5" value="${(Number(settings.commission_bps||1000)/100).toFixed(1)}"></div><div class="form-field"><label for="market-shipping">Default physical delivery fee (₦)</label><input id="market-shipping" type="number" min="0" step="100" value="${Number(settings.physical_shipping_kobo||200000)/100}"></div><button class="button button-primary" type="submit">Save marketplace settings</button><p class="form-error" id="market-settings-error"></p></form></div><div class="dash-panel"><h3>Payments configuration</h3><p class="modal-intro">Paystack checkout is ${state.config.payments_enabled?'configured':'not yet enabled'}. Add your Paystack secret key to the Vercel project environment to activate initialize, verify and webhook payments. Never put the secret key in this page.</p><span class="status-pill ${state.config.payments_enabled?'active':'pending'}">${state.config.payments_enabled?'Payments enabled':'Awaiting merchant keys'}</span></div>`;
  }
}
function renderSellerTab(tab,data) {
  const el=$('#dashboard-content');
  if(tab==='overview') {
    const products=data.products||[],orders=data.orders||[],payouts=data.payouts||[];
    el.innerHTML=`<div class="dash-panel"><h3>${html(data.seller?.store_name||'Your store')}</h3><p class="modal-intro">Your store is approved and ready. Product listings are reviewed before they appear in the public marketplace.</p><div class="metric-grid">${renderMetric('Products',products.length)}${renderMetric('Paid order items',orders.length)}${renderMetric('Pending settlement',money(data.totals?.outstanding))}${renderMetric('Payouts recorded',money(data.totals?.paid))}</div><div class="dash-actions"><button class="button button-primary" id="add-product-button">Add a product +</button><span class="status-pill approved">Seller approved</span></div></div>`;
  } else if(tab==='products') {
    el.innerHTML=`<div class="dash-panel"><div class="dashboard-head"><h3>Your products</h3><button class="dash-action primary" id="add-product-button">Add product +</button></div><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Product</th><th>Price</th><th>Type</th><th>Stock</th><th>Status</th><th>Action</th></tr></thead><tbody>${(data.products||[]).map(p=>`<tr><td><strong>${html(p.name)}</strong></td><td>${money(p.price_kobo)}</td><td>${html(p.product_type)}</td><td>${p.product_type==='digital'?'—':p.stock_qty}</td><td>${statusPill(p.status)}</td><td><button class="dash-action" data-edit-product="${p.id}">Edit</button></td></tr>`).join('')||tableEmpty('You have not added a product yet.',6)}</tbody></table></div></div>`;
  } else if(tab==='orders') {
    el.innerHTML=`<div class="dash-panel"><h3>Customer orders</h3><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Order / item</th><th>Customer</th><th>Quantity</th><th>Delivery</th><th>Update</th></tr></thead><tbody>${(data.orders||[]).map(o=>`<tr><td><strong>${html(o.order_number)}</strong><br>${html(o.product_name)}<br><small>${formatDate(o.created_at)}</small></td><td>${html(o.recipient_name)}<br>${html(o.phone)}<br><small>${html([o.shipping_address?.line1,o.shipping_address?.city,o.shipping_address?.state].filter(Boolean).join(', '))}</small></td><td>${o.quantity}</td><td>${statusPill(o.fulfillment_status)}${o.tracking_number?`<br><small>${html(o.tracking_carrier)} ${html(o.tracking_number)}</small>`:''}</td><td><div class="dash-actions"><button class="dash-action" data-fulfill="${o.id}" data-status="processing">Processing</button><button class="dash-action primary" data-fulfill="${o.id}" data-status="dispatched">Dispatch</button><button class="dash-action" data-fulfill="${o.id}" data-status="delivered">Delivered</button></div></td></tr>`).join('')||tableEmpty('No paid orders yet.',5)}</tbody></table></div></div>`;
  } else if(tab==='payouts') {
    el.innerHTML=`<div class="dash-panel"><h3>Settlement summary</h3><div class="metric-grid">${renderMetric('Pending',money(data.totals?.outstanding))}${renderMetric('Paid',money(data.totals?.paid))}${renderMetric('Total net earnings',money(data.totals?.net_total))}</div><p class="modal-intro">Payouts are added to your ledger once a customer's Paystack payment is verified. Marketplace administration approves and records settlement transfers.</p><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Created</th><th>Gross</th><th>Commission</th><th>Net</th><th>Status</th><th>Reference</th></tr></thead><tbody>${(data.payouts||[]).map(p=>`<tr><td>${formatDate(p.created_at)}</td><td>${money(p.gross_kobo)}</td><td>${money(p.commission_kobo)}</td><td>${money(p.net_kobo)}</td><td>${statusPill(p.status)}</td><td>${html(p.payout_reference||'—')}</td></tr>`).join('')||tableEmpty('No payout entries yet.',6)}</tbody></table></div></div>`;
  }
}
function renderStoreSettings() {
  const s=state.sellerData?.seller||state.seller||{};
  $('#dashboard-content').innerHTML=`<div class="dash-panel"><h3>Store profile and settlement details</h3><form id="store-settings-form" class="dash-form"><div class="form-field full"><label>Store name</label><input value="${escAttr(s.store_name||'')}" disabled></div><div class="form-field full"><label for="profile-description">Store description</label><textarea id="profile-description" rows="3">${html(s.description||'')}</textarea></div><div class="form-field"><label for="profile-phone">Business phone</label><input id="profile-phone" value="${escAttr(s.phone||'')}"></div><div class="form-field"><label for="profile-whatsapp">WhatsApp</label><input id="profile-whatsapp" value="${escAttr(s.whatsapp||'')}"></div><div class="form-field"><label for="profile-city">City</label><input id="profile-city" value="${escAttr(s.city||'')}"></div><div class="form-field"><label for="profile-state">State</label><input id="profile-state" value="${escAttr(s.state||'')}"></div><div class="form-field"><label for="profile-bank">Bank name</label><input id="profile-bank" value="${escAttr(s.bank_name||'')}"></div><div class="form-field"><label for="profile-bank-code">Bank code</label><input id="profile-bank-code" value="${escAttr(s.bank_code||'')}"></div><div class="form-field"><label for="profile-account">Account number</label><input id="profile-account" value="${escAttr(s.account_number||'')}"></div><div class="form-field"><label for="profile-account-name">Account name</label><input id="profile-account-name" value="${escAttr(s.account_name||'')}"></div><p class="form-error" id="store-settings-error"></p><button class="button button-primary" type="submit">Save changes</button></form></div>`;
}
function renderBuyerOrders(orders) {
  $('#dashboard-content').innerHTML=`<div class="dash-panel"><h3>Your purchases</h3><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Order</th><th>Items</th><th>Total</th><th>Payment</th><th>Order status</th><th>Date</th></tr></thead><tbody>${orders.map(o=>`<tr><td><strong>${html(o.order_number)}</strong></td><td>${(o.items||[]).map(i=>`${html(i.product_name)} × ${i.quantity}${i.download_url?` · <a href="${escAttr(i.download_url)}" target="_blank" rel="noopener">Download</a>`:''}${i.tracking_number?`<br><small>${html(i.tracking_carrier)} ${html(i.tracking_number)}</small>`:''}${i.fulfillment_status==='delivered'?`<br><button class="dash-action" data-review="${escAttr(i.product_id||'')}" data-order="${escAttr(o.id)}">Review item</button>`:''}`).join('<br>')}</td><td>${money(o.total_kobo)}</td><td>${statusPill(o.payment_status)}</td><td>${statusPill(o.status)}</td><td>${formatDate(o.created_at)}</td></tr>`).join('')||tableEmpty('Your orders will appear here after checkout.',6)}</tbody></table></div></div>`;
}
function renderBuyerWishlist(products) {
  $('#dashboard-content').innerHTML=`<div class="dash-panel"><h3>Your wishlist</h3><div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>Product</th><th>Store</th><th>Price</th><th></th></tr></thead><tbody>${products.map(p=>`<tr><td><strong>${html(p.name)}</strong></td><td>${html(p.store_name)}</td><td>${money(p.price_kobo)}</td><td><button class="dash-action" data-add="${p.id}">Add to bag</button></td></tr>`).join('')||tableEmpty('No saved products yet.',4)}</tbody></table></div></div>`;
}
function openSellerApplication() {
  if(!state.user){openAuth('login','Create an account or sign in before applying to sell.');return;}
  if(state.seller){if(state.seller.seller_status==='approved'){openDashboard('overview');return;}notify('Your seller application is ' + state.seller.seller_status + '.');openDashboard('sell');return;}
  showModal('seller-modal');
}
async function submitSellerApplication(e) {
  e.preventDefault(); $('#seller-error').textContent='';
  const payload={store_name:$('#store-name').value,slug:$('#store-slug').value,description:$('#store-description').value,phone:$('#seller-phone').value,whatsapp:$('#seller-whatsapp').value,business_type:$('#business-type').value,city:$('#seller-city').value,state:$('#seller-state').value,bank_name:$('#seller-bank').value,bank_code:$('#seller-bank-code').value,account_number:$('#seller-account').value,account_name:$('#seller-account-name').value};
  const submit=$('#seller-form button[type=submit]');submit.disabled=true;
  try {const data=await api('seller.apply',payload);state.seller=data.seller;closeModal('seller-modal');notify('Seller application submitted for review.');openDashboard('sell');}
  catch(err){$('#seller-error').textContent=err.message;} finally{submit.disabled=false;}
}
function openProductEditor(product) {
  $('#product-form').reset(); $('#product-id').value=product?.id||''; $('#product-title').textContent=product?'Edit product.':'Add a product.';
  if(product){$('#product-name').value=product.name||'';$('#product-category').value=state.categories.find(c=>c.name===product.category_name)?.id||state.categories[0]?.id||'';$('#product-type').value=product.product_type||'physical';$('#product-price').value=Number(product.price_kobo)/100;$('#product-compare').value=product.compare_at_kobo?Number(product.compare_at_kobo)/100:'';$('#product-stock').value=product.stock_qty||1;$('#product-sku').value=product.sku||'';$('#product-image').value=product.image_url||'';$('#product-description').value=product.description||'';$('#digital-url').value=product.digital_delivery_url||'';}
  updateProductType();showModal('product-modal');
}
function updateProductType(){const isDigital=$('#product-type').value==='digital';$('#product-stock-wrap').hidden=isDigital;$('#digital-url-wrap').hidden=!isDigital;$('#product-stock').required=!isDigital;}
async function uploadProductImage(e){
  const file=e.target.files?.[0]; if(!file)return;
  const stateEl=$('#image-upload-state'); stateEl.textContent='Preparing secure upload…';
  const allowed=['image/jpeg','image/png','image/webp','image/avif'];
  if(!allowed.includes(file.type)){stateEl.textContent='Choose a JPG, PNG, WebP or AVIF image.';e.target.value='';return;}
  if(file.size>2.5*1024*1024){stateEl.textContent='Image is too large. Maximum size is 2.5 MB.';e.target.value='';return;}
  try{
    const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read image.'));reader.readAsDataURL(file);});
    const match=String(dataUrl).match(/^data:(image\/(?:jpeg|png|webp|avif));base64,([A-Za-z0-9+/=]+)$/);
    if(!match)throw new Error('Image file could not be prepared.');
    const response=await fetch('/api/market-upload',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({file_name:file.name,mime_type:match[1],base64:match[2]})});
    const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||'Image upload failed.');
    $('#product-image').value=result.data.url;stateEl.textContent='Photo uploaded successfully.';
  }catch(err){stateEl.textContent=err.message;}
}

async function submitProduct(e){
  e.preventDefault();$('#product-error').textContent='';
  const payload={id:$('#product-id').value,name:$('#product-name').value,category_id:$('#product-category').value,product_type:$('#product-type').value,price_kobo:nairaToKobo($('#product-price').value),compare_at_kobo:nairaToKobo($('#product-compare').value)||null,stock_qty:Number($('#product-stock').value),sku:$('#product-sku').value,image_url:$('#product-image').value,description:$('#product-description').value,digital_delivery_url:$('#digital-url').value};
  const button=$('#product-form button[type=submit]');button.disabled=true;
  try{await api('seller.product.save',payload);closeModal('product-modal');notify('Product sent to marketplace review.');state.dashboardTab='products';loadDashboardTab();}
  catch(err){$('#product-error').textContent=err.message;}finally{button.disabled=false;}
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
      payload.full_name=$('#auth-name').value.trim();
      payload.phone=$('#auth-phone').value.trim();
      if (!$('#owner-token-wrap').hidden) payload.owner_token=$('#owner-token').value.trim();
    }
    const data=await api(registering?'auth.register':'auth.login',payload);
    state.user=data.user;
    await refreshSession();
    closeModal('auth-modal');
    notify(registering?'Your ETHAN MARKET account is ready.':'Welcome back.');
    if(state.user.role==='super_admin'||state.user.role==='admin')openDashboard('overview');
    else if(state.user.role==='seller')openDashboard('overview');
    await verifyPaymentFromUrl();
  }catch(err){$('#auth-error').textContent=err.message;}finally{button.disabled=false;}
}
async function refreshSession(){
  try{const data=await api('auth.me');state.user=data.user;state.seller=data.seller||null;if(state.user)await syncWishlist();}catch{state.user=null;state.seller=null;}
  const button=$('#account-button');button.title=state.user?`Signed in as ${state.user.full_name}`:'My account';
  const label=button.querySelector('.action-label');if(label)label.textContent=state.user?(state.user.role==='super_admin'?'Admin':'Account'):'Account';
}
async function submitCheckout(e){
  e.preventDefault();$('#checkout-error').textContent='';
  if(!state.config.payments_enabled){$('#checkout-error').textContent='Paystack checkout has not been activated yet. Your cart is saved; please try again later.';return;}
  const button=$('#checkout-form button[type=submit]');button.disabled=true;
  const payload={items:state.cart.map(x=>({product_id:x.product_id,quantity:x.quantity})),recipient_name:$('#checkout-recipient').value,phone:$('#checkout-phone').value,address_line1:$('#checkout-address').value,city:$('#checkout-city').value,state:$('#checkout-state').value,postal_code:$('#checkout-postal').value,buyer_note:$('#checkout-note').value};
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
async function logout(){try{await api('auth.logout');}catch{}state.user=null;state.seller=null;state.wishlist.clear();closeModal('dashboard-modal');notify('You have signed out.');}
async function adminAction(el){
  const action=el.dataset.adminAction;const id=el.dataset.id;const status=el.dataset.status;let payload={id,status};
  if(action==='product-status' && el.dataset.featured) payload.featured=el.dataset.featured==='true';
  if(action==='payout-status'&&status==='paid') {const ref=prompt('Enter the bank transfer / Paystack payout reference. Do not mark this paid until the transfer has cleared.');if(ref===null)return;payload.payout_reference=ref.trim();if(!payload.payout_reference){notify('A payout reference is required.');return;}}
  el.disabled=true;
  try{await api('admin.'+action,payload);notify('Marketplace record updated.');loadDashboardTab();}
  catch(e){notify(e.message);el.disabled=false;}
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
  const add=e.target.closest('[data-add]');if(add){addToCart(add.dataset.add);return;}
  const detailAdd=e.target.closest('[data-detail-add]');if(detailAdd){addToCart(detailAdd.dataset.detailAdd);closeModal('detail-modal');return;}
  const view=e.target.closest('[data-view]');if(view){showProduct(view.dataset.view);return;}
  const store=e.target.closest('[data-store]');if(store){showStore(store.dataset.store);return;}
  const review=e.target.closest('[data-review]');if(review){const rating=Number(prompt('Rate this item from 1 to 5 stars:','5'));if(!Number.isInteger(rating)||rating<1||rating>5){notify('Enter a rating from 1 to 5.');return;}const reviewText=prompt('Write a short review (optional):','')||'';try{await api('reviews.create',{product_id:review.dataset.review,order_id:review.dataset.order,rating,review_text:reviewText});notify('Thank you. Your review has been submitted.');}catch(err){notify(err.message);}return;}
  const wish=e.target.closest('[data-wish]');if(wish){toggleWishlist(wish.dataset.wish);return;}
  const qty=e.target.closest('[data-qty]');if(qty){changeQuantity(qty.dataset.qty,Number(qty.dataset.delta));return;}
  const authMode=e.target.closest('[data-auth-mode]');if(authMode){setAuthMode(authMode.dataset.authMode);return;}
  const dashTab=e.target.closest('[data-dash-tab]');if(dashTab){state.dashboardTab=dashTab.dataset.dashTab;loadDashboardTab();return;}
  const action=e.target.closest('[data-admin-action]');if(action){adminAction(action);return;}
  const fulfill=e.target.closest('[data-fulfill]');if(fulfill){sellerFulfillAction(fulfill);return;}
  const edit=e.target.closest('[data-edit-product]');if(edit){const product=(state.sellerData?.products||[]).find(p=>p.id===edit.dataset.editProduct);if(product)openProductEditor(product);return;}
  if(e.target.closest('#open-cart')){openCart();return;}
  if(e.target.closest('#close-cart')||e.target===$('#drawer-backdrop')){closeCart();return;}
  if(e.target.closest('#account-button')){if(state.user)openDashboard();else openAuth('login');return;}
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
$('#product-type').addEventListener('change',updateProductType);
$('#product-image-file').addEventListener('change', uploadProductImage);
$('#checkout-form').addEventListener('submit',submitCheckout);
$('#dashboard-content').addEventListener('submit',async e=>{
  if(e.target.id==='store-settings-form'){
    e.preventDefault();$('#store-settings-error').textContent='';
    try{const data=await api('seller.profile',{description:$('#profile-description').value,phone:$('#profile-phone').value,whatsapp:$('#profile-whatsapp').value,city:$('#profile-city').value,state:$('#profile-state').value,bank_name:$('#profile-bank').value,bank_code:$('#profile-bank-code').value,account_number:$('#profile-account').value,account_name:$('#profile-account-name').value});state.seller=data.seller;notify('Store profile saved.');}
    catch(err){$('#store-settings-error').textContent=err.message;}
  }
  if(e.target.id==='market-settings-form'){
    e.preventDefault();$('#market-settings-error').textContent='';
    try{const data=await api('admin.settings',{commission_bps:Math.round(Number($('#market-commission').value)*100),physical_shipping_kobo:nairaToKobo($('#market-shipping').value)});state.config.shipping_kobo=Number(data.settings.physical_shipping_kobo||0);state.config.commission_bps=Number(data.settings.commission_bps||1000);notify('Marketplace settings saved.');}
    catch(err){$('#market-settings-error').textContent=err.message;}
  }
});
$('#dashboard-content').addEventListener('change',async e=>{
  if(e.target.matches('[data-order-status]')&&e.target.value){try{await api('admin.order-status',{id:e.target.dataset.orderStatus,status:e.target.value});notify('Order status updated.');loadDashboardTab();}catch(err){notify(err.message);}}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeCart();$$('.modal-backdrop').filter(m=>!m.hidden).forEach(m=>closeModal(m.id));}});
$('#year').textContent=new Date().getFullYear();

async function start() {
  await initPublicData();
  await hydrateCart();
  await refreshSession();
  renderCart();
  await verifyPaymentFromUrl();

  // Allow a shareable, direct registration URL without requiring the visitor
  // to open Account and switch from Sign in to Create account.
  const params = new URLSearchParams(location.search);
  const directRegistration =
    (location.pathname === '/register' || location.pathname === '/register/') ||
    params.get('auth') === 'register';
  if (directRegistration) {
    if (state.user) openDashboard('overview');
    else openAuth('register');
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js?v=20261120-market-register-v1.3', { updateViaCache: 'none' }).catch(() => {});
  }
}
start();
