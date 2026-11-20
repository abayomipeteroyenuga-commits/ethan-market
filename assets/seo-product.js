'use strict';
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-add-product]');
  if(!button)return;
  const id=button.dataset.addProduct;
  if(!id)return;
  try{
    const cart=JSON.parse(localStorage.getItem('ethan-market-cart-v1')||'[]');
    const rows=Array.isArray(cart)?cart:[];
    const existing=rows.find(item=>item&&item.product_id===id);
    const max=button.dataset.type==='digital'?20:Math.max(0,Number(button.dataset.stock)||0);
    if(max<1){button.disabled=true;button.textContent='Currently out of stock';return;}
    if(existing){
      if(Number(existing.quantity)>=max){button.textContent='Maximum quantity already in bag';return;}
      existing.quantity=Math.min(max,Number(existing.quantity||0)+1);
    }else rows.push({product_id:id,quantity:1});
    localStorage.setItem('ethan-market-cart-v1',JSON.stringify(rows));
    button.textContent='Added — opening shopping bag…';
    window.location.assign('/#shop');
  }catch{
    button.textContent='Please open the marketplace to add this item';
  }
});
