// Ticket confirmation email. All user-supplied values are HTML-escaped.
const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatPrice = (n) => (Number(n) === 0 ? 'Free' : `₦${Number(n).toLocaleString('en-NG')}`);

const LAGOS = 'Africa/Lagos';

function eventWhen(event) {
  const start = new Date(event.startDateTime);
  const end = new Date(event.endDateTime);
  const time = { hour: 'numeric', minute: 'numeric', hour12: true, timeZone: LAGOS };
  return {
    date: start.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: LAGOS }),
    time: `${start.toLocaleTimeString('en-US', time)} - ${end.toLocaleTimeString('en-US', time)}`,
  };
}

function buildTicketEmail({ order, event, customer, tickets }) {
  const when = eventWhen(event);
  const e = escapeHtml;
  const ticketBlocks = tickets
    .map(
      (t, index) => `
    <div style="margin-bottom: 20px; padding: 10px; border: 1px solid #ddd; border-radius: 5px;">
      <p style="font-size: 14px; margin: 5px 0;">
        <strong>Ticket Type:</strong> ${e(String(t.name).toUpperCase())}<br>
        <strong>Ticket ID:</strong> ${e(t.ticketId)}<br>
        <strong>Price:</strong> ${formatPrice(t.price)}<br>
        <strong>Attendee Type:</strong> ${
          t.groupSize && !String(t.groupSize).toLowerCase().includes('unlimited')
            ? `Group of ${e(t.groupSize)} people`
            : 'Individual'
        }<br>
      </p>
      <img src="cid:qrcode${index}" alt="QR Code" style="width: 150px; height: 150px; margin-top: 10px; display: block;">
    </div>`
    )
    .join('');

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
      <h2 style="color: #1a73e8;">Ticket Confirmation</h2>
      <p style="font-size: 16px;">Dear ${e(customer.firstName)} ${e(customer.lastName)},</p>
      <p style="font-size: 16px;">Thank you for your ${order.provider === 'free' ? 'reservation' : 'purchase'}! You're all set for <strong>${e(event.eventName)}</strong>. Below are your event and ticket details.</p>

      <h3 style="color: #333; margin-top: 20px;">Event Details</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr><td style="padding: 8px; font-weight: bold;">Event</td><td style="padding: 8px;">${e(event.eventName)}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Date</td><td style="padding: 8px;">${e(when.date)}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Time</td><td style="padding: 8px;">${e(when.time)}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Venue</td><td style="padding: 8px;">${e(event.eventLocation?.venue)}</td></tr>
      </table>

      <h3 style="color: #333; margin-top: 20px;">Your Tickets</h3>
      ${ticketBlocks}

      <h3 style="color: #333; margin-top: 20px;">Transaction Details</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr><td style="padding: 8px; font-weight: bold;">Reference</td><td style="padding: 8px;">${e(order.reference)}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Subtotal</td><td style="padding: 8px;">${formatPrice(order.subtotal)}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Fees</td><td style="padding: 8px;">${formatPrice(order.fees)}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Total</td><td style="padding: 8px;">${formatPrice(order.total)}</td></tr>
      </table>

      <p style="font-size: 14px; margin-top: 20px;">
        Please present the QR code(s) above at the event for entry. Save this email or download the QR codes.
      </p>
      <p style="font-size: 14px;">
        Questions? Contact us at <a href="mailto:${e(process.env.RESEND_FROM_EMAIL)}" style="color: #1a73e8; text-decoration: none;">${e(process.env.RESEND_FROM_EMAIL)}</a>.
      </p>
      <p style="font-size: 14px; color: #555; margin-top: 20px; text-align: center;">
        We look forward to seeing you at the event!<br>
        The Genpay Events Team
      </p>
    </div>`;
}

module.exports = { escapeHtml, formatPrice, eventWhen, buildTicketEmail };
