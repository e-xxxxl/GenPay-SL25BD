// Origins that may call the API and that payment callbacks may return to.
const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.SECOND_FRONTEND_URL,
  'http://localhost:5173',
  'https://genpaysl.vercel.app',
  'https://genpay.ng',
]
  .filter(Boolean)
  .map((o) => o.replace(/\/+$/, ''));

module.exports = { allowedOrigins };
