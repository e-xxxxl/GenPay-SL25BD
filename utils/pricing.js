// Server-side pricing. This must stay in step with the fee schedule the checkout UI shows.
const MAX_TICKETS_PER_ORDER = 50;
// Per-ticket-type cap on the public page when the host hides remaining quantities.
const DEFAULT_MAX_PER_ORDER_WHEN_HIDDEN = 10;

const roundMoney = (n) => Math.round(n * 100) / 100;

function calculateFees(subtotal) {
  if (!Number.isFinite(subtotal) || subtotal <= 0) return 0;
  if (subtotal < 126667) return Math.round(subtotal * 0.05);
  if (subtotal < 400000) return 6000;
  if (subtotal < 600000) return 12000;
  if (subtotal < 2000000) return 18000;
  if (subtotal < 5000000) return 24000;
  if (subtotal < 8000000) return 30000;
  return 36000;
}

module.exports = {
  MAX_TICKETS_PER_ORDER,
  DEFAULT_MAX_PER_ORDER_WHEN_HIDDEN,
  roundMoney,
  calculateFees,
};
