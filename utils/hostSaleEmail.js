// Email sent to an event host when someone buys (or reserves) tickets for their event.
// Same visual language as the attendee email (see ticketEmail.js): table layout, inline styles,
// system fonts, inline logo. Attendee contact details are deliberately left out: the host sees
// those in their dashboard, behind their login.
const { escapeHtml, formatPrice, SUPPORT_EMAIL } = require('./ticketEmail');

const C = { header: '#0b0b0b', ink: '#18181b', muted: '#6b7280', line: '#e4e4e7', panel: '#fafafa', page: '#f1f1f3', accent: '#a228af' };
const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const LOGO_CID = 'genpay-logo';

const siteUrl = () => (process.env.FRONTEND_URL || 'https://genpay.ng').replace(/\/+$/, '');

const row = (label, value) => `
  <tr>
    <td style="padding:10px 0;border-top:1px solid ${C.line};font:13px/1.4 ${FONT};color:${C.muted};width:130px;vertical-align:top;">${label}</td>
    <td style="padding:10px 0;border-top:1px solid ${C.line};font:14px/1.4 ${FONT};color:${C.ink};vertical-align:top;">${value}</td>
  </tr>`;

// "2 x VIP, 1 x Regular" from the order's lines.
function ticketSummary(lines) {
  const byName = new Map();
  for (const line of lines) byName.set(line.name, (byName.get(line.name) || 0) + (line.quantity || 1));
  return [...byName].map(([name, qty]) => `${qty} x ${name}`).join(', ');
}

const ticketCount = (lines) => lines.reduce((sum, l) => sum + (l.quantity || 1), 0);

function facts({ order, event, soldSoFar }) {
  const count = ticketCount(order.lines);
  const buyer = order.lines[0]?.customer;
  const buyerName = buyer ? `${buyer.firstName} ${buyer.lastName}`.trim() : 'Someone';
  const isFree = order.provider === 'free';
  return {
    count,
    buyerName,
    isFree,
    noun: isFree ? 'reservation' : 'sale',
    subject: `${isFree ? 'New reservation' : 'New ticket sale'}: ${ticketSummary(order.lines)} for ${event.eventName}`,
    link: `${siteUrl()}/sales/${event._id}`,
    soldSoFar,
  };
}

function buildHostSaleEmail({ order, event, host, soldSoFar }) {
  const e = escapeHtml;
  const f = facts({ order, event, soldSoFar });
  const names = [...new Set(order.lines.map((l) => `${l.customer?.firstName || ''} ${l.customer?.lastName || ''}`.trim()).filter(Boolean))];
  const preheader = `${f.buyerName} ${f.isFree ? 'reserved' : 'bought'} ${f.count} ticket${f.count === 1 ? '' : 's'} for ${event.eventName}`;
  const greeting = host.firstName || host.organizationName || 'there';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${e(f.subject)}</title></head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${e(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${C.page};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;">
      <tr><td style="background:${C.header};padding:22px 28px;border-bottom:3px solid ${C.accent};">
        <img src="cid:${LOGO_CID}" width="140" alt="Genpay" style="display:block;width:140px;height:auto;border:0;font:600 20px ${FONT};color:#ffffff;">
      </td></tr>

      <tr><td style="padding:30px 28px 8px;">
        <h1 style="margin:0 0 10px;font:600 22px/1.3 ${FONT};color:${C.ink};">${f.isFree ? 'New reservation' : 'New ticket sale'}</h1>
        <p style="margin:0;font:15px/1.6 ${FONT};color:${C.ink};">
          Hi ${e(greeting)}, <strong>${e(f.buyerName)}</strong> ${f.isFree ? 'reserved' : 'bought'}
          ${f.count} ticket${f.count === 1 ? '' : 's'} for <strong>${e(event.eventName)}</strong>.
        </p>
      </td></tr>

      <tr><td style="padding:20px 28px 4px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          ${row('Tickets', e(ticketSummary(order.lines)))}
          ${names.length ? row(names.length === 1 ? 'Attendee' : 'Attendees', e(names.join(', '))) : ''}
          ${f.isFree ? '' : row('You earn', `<strong>${formatPrice(order.subtotal)}</strong> <span style="color:${C.muted};">(before payout fees)</span>`)}
          ${row('Sold so far', `${f.soldSoFar} ticket${f.soldSoFar === 1 ? '' : 's'}`)}
          ${row('Reference', `<span style="font-family:Consolas,'Courier New',monospace;font-size:12px;">${e(order.reference)}</span>`)}
          <tr><td colspan="2" style="border-top:1px solid ${C.line};font-size:0;line-height:0;">&nbsp;</td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:16px 28px 30px;">
        <a href="${e(f.link)}" style="display:inline-block;background:${C.header};color:#ffffff;text-decoration:none;font:600 14px ${FONT};padding:11px 20px;border-radius:6px;">View sales and guest list</a>
      </td></tr>

      <tr><td style="background:${C.panel};padding:18px 28px;border-top:1px solid ${C.line};font:12px/1.6 ${FONT};color:${C.muted};">
        You are receiving this because you host <strong>${e(event.eventName)}</strong> on Genpay.
        Questions? <a href="mailto:${SUPPORT_EMAIL}" style="color:${C.muted};">${SUPPORT_EMAIL}</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function buildHostSaleText({ order, event, host, soldSoFar }) {
  const f = facts({ order, event, soldSoFar });
  return [
    f.isFree ? 'New reservation' : 'New ticket sale',
    '',
    `Hi ${host.firstName || host.organizationName || 'there'},`,
    `${f.buyerName} ${f.isFree ? 'reserved' : 'bought'} ${f.count} ticket${f.count === 1 ? '' : 's'} for ${event.eventName}.`,
    '',
    `Tickets: ${ticketSummary(order.lines)}`,
    ...(f.isFree ? [] : [`You earn: ${formatPrice(order.subtotal)} (before payout fees)`]),
    `Sold so far: ${f.soldSoFar}`,
    `Reference: ${order.reference}`,
    '',
    `View sales and guest list: ${f.link}`,
    '',
    `You are receiving this because you host ${event.eventName} on Genpay.`,
  ].join('\n');
}

module.exports = { buildHostSaleEmail, buildHostSaleText, hostSaleSubject: (args) => facts(args).subject, ticketSummary };
