const EVENT_ID = '64b7f0f0f0f0f0f0f0f0f0f1';

const makeEvent = (over = {}) => ({
  _id: EVENT_ID,
  host: 'host1',
  eventName: 'Lagos Night',
  slug: 'lagos-night',
  isPublished: true,
  showTicketQuantity: true,
  startDateTime: new Date(Date.now() + 2 * 864e5),
  endDateTime: new Date(Date.now() + 3 * 864e5),
  eventLocation: { venue: 'Main Hall' },
  tickets: [
    { id: 't1', name: 'Regular', price: 5000, quantity: 3, ticketType: 'Individual', purchaseLimit: 5 },
    { id: 't2', name: 'VIP', price: 20000, quantity: 10, ticketType: 'Individual' },
    { id: 'free', name: 'Free Pass', price: 0, quantity: 4, ticketType: 'Individual' },
  ],
  ...over,
});

const attendee = (n = 1) => ({
  firstName: 'Ada',
  lastName: `Buyer${n}`,
  email: `ada${n}@example.com`,
  phone: '08000000000',
  location: 'Lagos',
});

// `n` single-quantity cart lines for a ticket tier, one attendee each.
const cart = (ticketId, n = 1) => Array.from({ length: n }, (_, i) => ({ ticketId, quantity: 1, customer: attendee(i + 1) }));

module.exports = { EVENT_ID, makeEvent, attendee, cart };
