// OTA bundle 1 of store version 1.4.0 (fixture for TestHermesOTABundles).
function chargeCard(amount) {
  if (amount > 100) {
    throw new Error("card declined: " + amount); // @throw
  }
  return amount;
}

function checkout(cart) {
  var total = cart.items * 60;
  return chargeCard(total); // @call
}

globalThis.__fixtureCheckout = checkout;
