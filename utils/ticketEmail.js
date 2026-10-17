// Ticket confirmation email. All user-supplied values are HTML-escaped.
//
// Built for email clients, not browsers: nested tables, inline styles, system fonts, no
// gradients/SVG/web fonts (Outlook and Gmail strip or mangle them). The logo and QR codes are
// inline (CID) attachments so they display without a "load remote images" prompt; each QR also
// has a plain link as a fallback.
const fs = require('fs');
const path = require('path');

const SUPPORT_EMAIL = 'support@genpay.ng';
const LOGO_CID = 'genpay-logo';
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'email', 'genpay-logo.png');
const LAGOS = 'Africa/Lagos';

const C = {
  header: '#0b0b0b',
  ink: '#18181b',
  muted: '#6b7280',
  line: '#e4e4e7',
  panel: '#fafafa',
  page: '#f1f1f3',
  accent: '#a228af',
};
const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatPrice = (n) => (Number(n) === 0 ? 'Free' : `₦${Number(n).toLocaleString('en-NG')}`);

function eventWhen(event) {
  const start = new Date(event.startDateTime);
  const end = new Date(event.endDateTime);
  const time = { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: LAGOS };
  return {
    date: start.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: LAGOS }),
    time: `${start.toLocaleTimeString('en-US', time)} - ${end.toLocaleTimeString('en-US', time)} (WAT)`,
  };
}

const siteUrl = () => (process.env.FRONTEND_URL || 'https://genpay.ng').replace(/\/+$/, '');

let logoBase64;
function logoAttachment() {
  try {
    logoBase64 = logoBase64 || fs.readFileSync(LOGO_PATH).toString('base64');
    return { filename: 'genpay-logo.png', content: logoBase64, contentType: 'image/png', contentId: LOGO_CID };
  } catch (err) {
    console.error('[email] logo asset missing, sending without it:', err.message);
    return null;
  }
}

const compact = (iso) => new Date(iso).toISOString().replace(/[-:]|\.\d{3}/g, '');

function calendarUrl(event) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.eventName,
    dates: `${compact(event.startDateTime)}/${compact(event.endDateTime)}`,
    location: event.eventLocation?.venue || '',
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

const mapsUrl = (event) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.eventLocation?.venue || event.eventName)}`;

const attendeeKind = (t) =>
  t.groupSize && !String(t.groupSize).toLowerCase().includes('unlimited') ? `Group of ${t.groupSize}` : 'Individual';

// QR attachments are referenced by a stable per-ticket content id.
const qrCid = (t) => `qr-${String(t.ticketId).replace(/[^a-z0-9]/gi, '').slice(0, 24)}`;

function qrAttachments(tickets) {
  return tickets
    .filter((t) => t.qrCode)
    .map((t) => ({ filename: `ticket_${t.ticketId}.png`, path: t.qrCode, contentId: qrCid(t) }));
}

const row = (label, value) => `
  <tr>
    <td style="padding:10px 0;border-top:1px solid ${C.line};font:13px/1.4 ${FONT};color:${C.muted};width:110px;vertical-align:top;">${label}</td>
    <td style="padding:10px 0;border-top:1px solid ${C.line};font:14px/1.4 ${FONT};color:${C.ink};vertical-align:top;">${value}</td>
  </tr>`;

function ticketBlock(t, index, total) {
  const e = escapeHtml;
  return `
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid ${C.line};border-radius:6px;margin:0 0 14px;">
    <tr>
      <td style="padding:16px 18px 6px;font:12px/1.4 ${FONT};color:${C.muted};letter-spacing:.04em;text-transform:uppercase;">
        Ticket ${index + 1} of ${total}
      </td>
    </tr>
    <tr>
      <td style="padding:0 18px;font:600 17px/1.3 ${FONT};color:${C.ink};">${e(t.name)}</td>
    </tr>
    <tr>
      <td style="padding:4px 18px 12px;font:13px/1.5 ${FONT};color:${C.muted};">
        ${e(attendeeKind(t))}${t.attendeeName ? ` &middot; ${e(t.attendeeName)}` : ''} &middot; ${formatPrice(t.price)}
      </td>
    </tr>
    ${
      t.qrCode
        ? `<tr>
      <td align="center" style="padding:6px 18px 6px;">
        <img src="cid:${qrCid(t)}" width="168" height="168" alt="QR code for ticket ${e(t.ticketId)}" style="display:block;width:168px;height:168px;border:1px solid ${C.line};padding:6px;background:#ffffff;">
      </td>
    </tr>
    <tr>
      <td align="center" style="padding:0 18px 4px;font:12px/1.5 ${FONT};color:${C.muted};">
        <a href="${e(t.qrCode)}" style="color:${C.muted};">Open QR code in browser</a>
      </td>
    </tr>`
        : ''
    }
    <tr>
      <td align="center" style="padding:6px 18px 16px;font:12px/1.4 'SFMono-Regular',Consolas,'Courier New',monospace;color:${C.muted};">
        ${e(t.ticketId)}
      </td>
    </tr>
  </table>`;
}

function buildTicketEmail({ order, event, customer, tickets }) {
  const e = escapeHtml;
  const when = eventWhen(event);
  const base = siteUrl();
  const isFree = order.provider === 'free';
  const isPayer = String(customer.email).toLowerCase() === String(order.email).toLowerCase();
  const count = tickets.length;
  const headline = isFree ? 'Your reservation is confirmed' : 'Your tickets are confirmed';
  const preheader = `${count} ticket${count === 1 ? '' : 's'} for ${event.eventName} - ${when.date}`;

  const orderRows = [row('Reference', `<span style="font-family:Consolas,'Courier New',monospace;">${e(order.reference)}</span>`)];
  if (isPayer) {
    orderRows.push(row('Subtotal', formatPrice(order.subtotal)));
    orderRows.push(row('Fees', formatPrice(order.fees)));
    orderRows.push(row(isFree ? 'Total' : 'Total paid', `<strong>${formatPrice(order.total)}</strong>`));
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${e(headline)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${e(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${C.page};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;">

        <tr>
          <td style="background:${C.header};padding:22px 28px;border-bottom:3px solid ${C.accent};">
            <img src="cid:${LOGO_CID}" width="140" alt="Genpay" style="display:block;width:140px;height:auto;border:0;font:600 20px ${FONT};color:#ffffff;">
          </td>
        </tr>

        <tr>
          <td style="padding:30px 28px 8px;">
            <h1 style="margin:0 0 10px;font:600 22px/1.3 ${FONT};color:${C.ink};">${e(headline)}</h1>
            <p style="margin:0;font:15px/1.6 ${FONT};color:${C.ink};">
              Hi ${e(customer.firstName)}, ${isFree ? "you're all set." : 'thank you for your purchase.'}
              Your ${count === 1 ? 'ticket' : `${count} tickets`} for
              <strong>${e(event.eventName)}</strong> ${count === 1 ? 'is' : 'are'} below.
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:20px 28px 4px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              ${row('Event', `<strong>${e(event.eventName)}</strong>`)}
              ${row('Date', e(when.date))}
              ${row('Time', e(when.time))}
              ${row('Venue', e(event.eventLocation?.venue))}
              <tr>
                <td style="border-top:1px solid ${C.line};"></td>
                <td style="padding:10px 0 4px;border-top:1px solid ${C.line};font:13px/1.4 ${FONT};">
                  <a href="${e(calendarUrl(event))}" style="color:${C.accent};text-decoration:none;white-space:nowrap;">Add to calendar</a>
                  <span style="color:${C.line};">&nbsp;|&nbsp;</span>
                  <a href="${e(mapsUrl(event))}" style="color:${C.accent};text-decoration:none;white-space:nowrap;">Get directions</a>
                  ${event.slug ? `<span style="color:${C.line};">&nbsp;|&nbsp;</span><a href="${e(`${base}/explore/${event.slug}`)}" style="color:${C.accent};text-decoration:none;white-space:nowrap;">Event page</a>` : ''}
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:22px 28px 0;">
            <h2 style="margin:0 0 12px;font:600 16px/1.3 ${FONT};color:${C.ink};">Your ${count === 1 ? 'ticket' : 'tickets'}</h2>
            ${tickets.map((t, i) => ticketBlock(t, i, count)).join('')}
            <p style="margin:2px 0 0;font:13px/1.6 ${FONT};color:${C.muted};">
              Show the QR code at the entrance. Each code can be scanned once, so please don't share screenshots of it.
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:24px 28px 4px;">
            <h2 style="margin:0 0 6px;font:600 16px/1.3 ${FONT};color:${C.ink};">Order details</h2>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              ${orderRows.join('')}
              <tr><td colspan="2" style="border-top:1px solid ${C.line};font-size:0;line-height:0;">&nbsp;</td></tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:20px 28px 30px;font:13px/1.6 ${FONT};color:${C.muted};">
            Need help with this order? Email <a href="mailto:${SUPPORT_EMAIL}" style="color:${C.accent};text-decoration:none;white-space:nowrap;">${SUPPORT_EMAIL}</a>
            and quote reference ${e(order.reference)}.
          </td>
        </tr>

        <tr>
          <td style="background:${C.panel};padding:18px 28px;border-top:1px solid ${C.line};font:12px/1.6 ${FONT};color:${C.muted};">
            Sent to ${e(customer.email)} because tickets were issued to this address on Genpay.<br>
            <a href="${base}/legal" style="color:${C.muted};">Terms</a> &nbsp;&middot;&nbsp;
            <a href="${base}/legal/refund-policy" style="color:${C.muted};">Refund policy</a> &nbsp;&middot;&nbsp;
            <a href="${base}" style="color:${C.muted};">genpay.ng</a>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function buildTicketText({ order, event, customer, tickets }) {
  const when = eventWhen(event);
  const base = siteUrl();
  const isFree = order.provider === 'free';
  const isPayer = String(customer.email).toLowerCase() === String(order.email).toLowerCase();
  const lines = [
    isFree ? 'Your reservation is confirmed' : 'Your tickets are confirmed',
    '',
    `Hi ${customer.firstName},`,
    `Your ${tickets.length === 1 ? 'ticket' : `${tickets.length} tickets`} for ${event.eventName} ${tickets.length === 1 ? 'is' : 'are'} below.`,
    '',
    `Event: ${event.eventName}`,
    `Date:  ${when.date}`,
    `Time:  ${when.time}`,
    `Venue: ${event.eventLocation?.venue || ''}`,
    `Add to calendar: ${calendarUrl(event)}`,
    `Directions: ${mapsUrl(event)}`,
    '',
    'TICKETS',
    ...tickets.flatMap((t, i) => [
      `${i + 1}. ${t.name} (${attendeeKind(t)}${t.attendeeName ? `, ${t.attendeeName}` : ''}) - ${formatPrice(t.price)}`,
      `   Ticket ID: ${t.ticketId}`,
      ...(t.qrCode ? [`   QR code: ${t.qrCode}`] : []),
    ]),
    '',
    'Show the QR code at the entrance. Each code can be scanned once.',
    '',
    'ORDER',
    `Reference: ${order.reference}`,
    ...(isPayer
      ? [`Subtotal: ${formatPrice(order.subtotal)}`, `Fees: ${formatPrice(order.fees)}`, `${isFree ? 'Total' : 'Total paid'}: ${formatPrice(order.total)}`]
      : []),
    '',
    `Need help? Email ${SUPPORT_EMAIL} and quote reference ${order.reference}.`,
    `Terms: ${base}/legal  |  Refund policy: ${base}/legal/refund-policy`,
  ];
  return lines.join('\n');
}

module.exports = {
  escapeHtml,
  formatPrice,
  eventWhen,
  buildTicketEmail,
  buildTicketText,
  logoAttachment,
  qrAttachments,
  SUPPORT_EMAIL,
};
