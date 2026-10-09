// Thin Paystack client. Secrets are read from the environment and never logged.
const axios = require('axios');

class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ProviderError';
    this.providerStatus = status;
  }
}

const client = axios.create({ baseURL: 'https://api.paystack.co', timeout: 15000 });

function authHeaders() {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new ProviderError('Payment provider is not configured');
  return { Authorization: `Bearer ${key}` };
}

function wrap(err) {
  if (err instanceof ProviderError) return err;
  const status = err.response?.status;
  // Log the provider's message only (never request headers/config, which hold the secret).
  console.error('Paystack request failed:', status || err.code || 'no-response', err.response?.data?.message || err.message);
  return new ProviderError('Payment provider request failed', status);
}

async function initializeTransaction({ email, amountKobo, reference, callbackUrl, metadata, currency = 'NGN' }) {
  try {
    const { data } = await client.post(
      '/transaction/initialize',
      { email, amount: amountKobo, currency, reference, callback_url: callbackUrl, metadata },
      { headers: authHeaders() }
    );
    if (!data?.status || !data.data?.authorization_url) {
      throw new ProviderError(data?.message || 'Failed to initialize transaction');
    }
    return data.data;
  } catch (err) {
    throw wrap(err);
  }
}

// Resolves to the transaction object, or null when Paystack has no such transaction
// (e.g. the buyer never reached the payment page). Throws ProviderError on outages.
async function verifyTransaction(reference) {
  try {
    const { data } = await client.get(`/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: authHeaders(),
    });
    return data?.data || null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw wrap(err);
  }
}

module.exports = { ProviderError, initializeTransaction, verifyTransaction };
