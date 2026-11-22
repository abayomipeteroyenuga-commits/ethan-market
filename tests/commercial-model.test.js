'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {calculateCommissionKobo,calculateCheckoutBreakdown}=require('../lib/commercial');

test('5% commission and seller net are calculated in integer kobo',()=>{
  const gross=10_000_000; // ₦100,000
  const commission=calculateCommissionKobo(gross,500);
  assert.equal(commission,500_000); // ₦5,000
  assert.equal(gross-commission,9_500_000); // ₦95,000 seller net
});

test('commission rounds to the nearest kobo',()=>{
  assert.equal(calculateCommissionKobo(101,500),5);
});

test('buyer total includes delivery and discount but no gateway surcharge',()=>{
  const breakdown=calculateCheckoutBreakdown({
    subtotalKobo:10_000_000,deliveryKobo:250_000,discountKobo:100_000
  });
  assert.deepEqual(breakdown,{
    subtotalKobo:10_000_000,deliveryKobo:250_000,discountKobo:100_000,
    paymentProcessingFeeKobo:0,totalKobo:10_150_000
  });
});

test('digital-only checkout has no delivery charge',()=>{
  const breakdown=calculateCheckoutBreakdown({subtotalKobo:1_000_000});
  assert.equal(breakdown.totalKobo,1_000_000);
  assert.equal(breakdown.paymentProcessingFeeKobo,0);
});

test('invalid negative monetary values are rejected',()=>{
  assert.throws(()=>calculateCheckoutBreakdown({subtotalKobo:100,deliveryKobo:-1}),RangeError);
});
