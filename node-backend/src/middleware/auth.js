const { getClientByApiKey } = require('../db/clientsRepo');

async function authenticateClient(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing X-API-Key header' });

  const client = await getClientByApiKey(apiKey);
  if (!client) return res.status(401).json({ error: 'Invalid API key' });

  req.client = client; // attach for downstream use
  next();
}

module.exports = { authenticateClient };