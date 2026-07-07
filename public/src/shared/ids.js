// Shared unique identifier generators for designs and purchase transactions.

export function makeDesignId() {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function makePurchaseRequestId() {
  return `buy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
