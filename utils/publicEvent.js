// Shapes event data for PUBLIC responses. Hosts choose (event.showTicketQuantity) whether
// the remaining ticket count is visible; when it is not, the number must not appear anywhere
// in the response. Inventory is still enforced server-side regardless of this setting.
const { DEFAULT_MAX_PER_ORDER_WHEN_HIDDEN } = require('./pricing');

// Existing events pre-date the setting and keep showing quantities.
const shouldShowQuantity = (event) => event.showTicketQuantity !== false;

function toPublicTickets(event) {
  const show = shouldShowQuantity(event);
  return (Array.isArray(event.tickets) ? event.tickets : []).map((t) => {
    const remaining = Number.isFinite(t.quantity) ? t.quantity : 0;
    const limit = t.purchaseLimit > 0 ? t.purchaseLimit : null;
    const publicTicket = {
      id: t.id,
      name: t.name,
      price: t.price,
      ticketType: t.ticketType,
      ticketDescription: t.ticketDescription,
      groupSize: t.groupSize,
      groupPrice: t.groupPrice,
      groupPriceCurrency: t.groupPriceCurrency,
      perTicketPrice: t.perTicketPrice,
      perTicketCurrency: t.perTicketCurrency,
      purchaseLimit: t.purchaseLimit,
      perks: t.perks,
      transferFees: t.transferFees,
      customQuestions: t.customQuestions || [],
      soldOut: remaining <= 0,
      // Selectable ceiling that does not depend on (hidden) stock levels.
      maxPerOrder: limit ?? (show ? null : DEFAULT_MAX_PER_ORDER_WHEN_HIDDEN),
    };
    if (show) publicTicket.quantity = remaining;
    return publicTicket;
  });
}

module.exports = { shouldShowQuantity, toPublicTickets };
