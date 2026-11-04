// OTA bundle 2 of store version 1.4.0 (fixture for TestHermesOTABundles): the same app a
// release later, the code moved and a discount added, so every position differs from bundle 1.
var DISCOUNT = 0.9;

function applyDiscount(amount) {
  return Math.round(amount * DISCOUNT);
}

function chargeCard(amount) {
  var charged = applyDiscount(amount);
  if (charged > 100) {
    throw new Error("card declined: " + charged); // @throw
  }
  return charged;
}

function checkout(cart) {
  var total = cart.items * 60;
  var receipt = { total: total };
  receipt.charged = chargeCard(total); // @call
  return receipt;
}

globalThis.__fixtureCheckout = checkout;
