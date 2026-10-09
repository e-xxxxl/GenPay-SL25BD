// controllers/paymentController.js
// HTTP layer for checkout. All pricing/verification/fulfilment logic is in services/orderService.
const crypto = require('crypto');
const mongoose = require('mongoose');
const orders = require('../services/orderService');
const { ProviderError } = require('../services/paystack');
const { allowedOrigins } = require('../config/origins');

const { OrderError } = orders;

function callbackUrlFor(requested) {
  try {
    const origin = new URL(requested).origin;
    if (allowedOrigins.includes(origin)) return `${origin}/checkout/success`;
  } catch {
    // fall through to the configured frontend
  }
  const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
  return `${base}/checkout/success`;
}

async function loadSellableEvent(eventId) {
  if (!mongoose.Types.ObjectId.isValid(eventId)) throw new OrderError(404, 'Event not found.');
  const event = await orders.deps.Event.findById(eventId).select('eventName isPublished endDateTime tickets host').lean();
  orders.assertSellable(event);
  return event;
}

function sendError(res, err, fallbackMessage) {
  if (err instanceof OrderError) {
    return res.status(err.status).json({ status: 'fail', message: err.message, code: err.code, data: err.data });
  }
  if (err instanceof ProviderError) {
    return res.status(503).json({
      status: 'error',
      message: 'Our payment provider is temporarily unreachable. If you were charged, your tickets will still be issued automatically; otherwise please try again shortly.',
    });
  }
  console.error(fallbackMessage, err);
  return res.status(500).json({ status: 'error', message: fallbackMessage });
}

// Translates a settlement outcome into an HTTP response.
async function respondWithSettlement(res, settlement, reference, successStatus = 200) {
  switch (settlement.state) {
    case 'completed':
      return res.status(successStatus).json({ status: 'success', data: settlement.result });
    case 'pending':
    case 'processing':
      return res.status(202).json({
        status: settlement.state,
        message: 'We have not received confirmation of this payment yet.',
        data: { reference },
      });
    case 'failed':
      return res.status(402).json({ status: 'fail', code: 'payment_failed', message: 'This payment was not successful. You have not been charged for tickets.' });
    case 'mismatch':
      return res.status(409).json({
        status: 'fail',
        code: 'payment_mismatch',
        message: `We could not match this payment to your order. Please contact support and quote reference ${reference}.`,
      });
    case 'unfulfillable':
      return res.status(409).json({
        status: 'fail',
        code: 'sold_out_after_payment',
        message: `Your payment was received, but the tickets sold out before your order could be confirmed. Please contact support and quote reference ${reference} for a refund.`,
      });
    case 'not_found':
      return res.status(404).json({ status: 'fail', message: 'We could not find a payment with this reference.' });
    default:
      return res.status(503).json({ status: 'error', message: 'We are still confirming your payment. Please check again in a moment; do not pay twice.' });
  }
}

// POST /api/events/initialize-payment
exports.initializePayment = async (req, res) => {
  try {
    const { eventId, tickets, expectedTotal, callbackUrl } = req.body || {};
    const event = await loadSellableEvent(eventId);
    const cart = orders.buildCart(event, tickets);

    if (cart.total <= 0) {
      throw new OrderError(400, 'This order is free and does not need a payment.', 'free_order');
    }
    if (expectedTotal !== undefined && Number(expectedTotal) !== cart.total) {
      throw new OrderError(409, 'The price of your order has changed. Please review it and try again.', 'price_changed', {
        subtotal: cart.subtotal,
        fees: cart.fees,
        total: cart.total,
      });
    }

    const email = cart.lines[0].customer.email;
    const order = await orders.createOrder(event, cart, { provider: 'paystack', email });
    try {
      const init = await orders.deps.paystack.initializeTransaction({
        email,
        amountKobo: cart.amountKobo,
        reference: order.reference,
        callbackUrl: callbackUrlFor(callbackUrl),
        metadata: { orderId: String(order._id), eventId: String(event._id) },
      });
      return res.status(200).json({
        status: 'success',
        data: {
          authorization_url: init.authorization_url,
          access_code: init.access_code,
          reference: order.reference,
          subtotal: cart.subtotal,
          fees: cart.fees,
          total: cart.total,
        },
      });
    } catch (err) {
      await orders.deps.Order.updateOne({ _id: order._id }, { $set: { status: 'failed', failureReason: 'initialize_failed' } });
      throw err;
    }
  } catch (err) {
    if (err instanceof ProviderError) {
      return res.status(502).json({ status: 'error', message: 'We could not start your payment. Please try again.' });
    }
    return sendError(res, err, 'Failed to initialize payment.');
  }
};

// GET /api/events/verify-payment/:reference
exports.verifyPayment = async (req, res) => {
  try {
    const reference = String(req.params.reference || '').slice(0, 100);
    if (!reference) return res.status(400).json({ status: 'fail', message: 'Payment reference is required.' });
    const settlement = await orders.settleOrder(reference);
    return await respondWithSettlement(res, settlement, reference);
  } catch (err) {
    return sendError(res, err, 'Failed to verify payment.');
  }
};

// POST /api/events/:id/purchase-ticket
// Two uses, both safe against forged input:
//  * with a payment `reference`: idempotently settle that order (kept for existing clients);
//  * without one: reserve tickets for a FREE order. The price is computed here, so an order
//    that costs money is rejected no matter what the client claims.
exports.purchaseTicket = async (req, res) => {
  try {
    const { tickets, reference } = req.body || {};
    // Old clients labelled free reservations with a client-made "FREE_" reference.
    if (typeof reference === 'string' && reference && !/^FREE_/.test(reference)) {
      const settlement = await orders.settleOrder(reference.slice(0, 100));
      return await respondWithSettlement(res, settlement, reference, 200);
    }

    const event = await loadSellableEvent(req.params.id);
    const cart = orders.buildCart(event, tickets);
    if (cart.total > 0) {
      throw new OrderError(402, 'Payment is required for this order.', 'payment_required');
    }
    const order = await orders.createOrder(event, cart, { provider: 'free', email: cart.lines[0].customer.email });
    const settlement = await orders.settleOrder(order.reference);
    return await respondWithSettlement(res, settlement, order.reference, 201);
  } catch (err) {
    return sendError(res, err, 'Failed to reserve tickets.');
  }
};

function signatureMatches(rawBody, signature) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret || !rawBody || typeof signature !== 'string') return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest();
  let given;
  try {
    given = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
exports.signatureMatches = signatureMatches;

// POST /api/events/paystack-webhook  (configure this URL in the Paystack dashboard)
exports.paystackWebhook = async (req, res) => {
  if (!signatureMatches(req.rawBody, req.headers['x-paystack-signature'])) {
    return res.status(401).json({ status: 'error', message: 'Invalid signature' });
  }
  const event = req.body || {};
  if (event.event !== 'charge.success') return res.status(200).json({ status: 'ignored' });

  const reference = event.data?.reference;
  if (typeof reference !== 'string' || !reference) return res.status(200).json({ status: 'ignored' });

  try {
    // The webhook payload is only a trigger: the order is re-verified against Paystack's API.
    const settlement = await orders.settleOrder(reference);
    // Ask Paystack to redeliver only when we may still be able to succeed later.
    const retryable = ['error', 'pending'].includes(settlement.state);
    return res.status(retryable ? 500 : 200).json({ status: settlement.state });
  } catch (err) {
    console.error('Webhook processing error:', err.message);
    return res.status(500).json({ status: 'error' });
  }
};
