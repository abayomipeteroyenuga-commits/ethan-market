'use strict';

function safeKobo(value,label) {
  const amount=Number(value);
  if(!Number.isSafeInteger(amount)||amount<0) throw new RangeError(label+' must be a non-negative safe integer in kobo.');
  return amount;
}

function calculateCommissionKobo(grossKobo,commissionBps=500) {
  const gross=safeKobo(grossKobo,'Gross amount');
  const bps=Number(commissionBps);
  if(!Number.isInteger(bps)||bps<0||bps>5000) throw new RangeError('Commission basis points must be between 0 and 5000.');
  return Math.round(gross*bps/10000);
}

function calculateCheckoutBreakdown({subtotalKobo,deliveryKobo=0,discountKobo=0}) {
  const subtotal=safeKobo(subtotalKobo,'Subtotal');
  const delivery=safeKobo(deliveryKobo,'Delivery fee');
  const discount=safeKobo(discountKobo,'Discount');
  if(discount>subtotal) throw new RangeError('Discount cannot exceed the product subtotal.');
  return {
    subtotalKobo:subtotal,
    deliveryKobo:delivery,
    discountKobo:discount,
    paymentProcessingFeeKobo:0,
    totalKobo:subtotal+delivery-discount
  };
}

module.exports={calculateCommissionKobo,calculateCheckoutBreakdown};
