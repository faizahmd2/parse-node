const pool = require('./pool');

async function getClientByApiKey(apiKey) {
  const result = await pool.query(
    'SELECT * FROM clients WHERE api_key = $1 AND active = true',
    [apiKey]
  );
  return result.rows[0];
}

async function getClientCategories(clientId) {
  const result = await pool.query(
    'SELECT type, value, description FROM client_categories WHERE client_id = $1',
    [clientId]
  );
  const categories = result.rows.filter(r => r.type === 'category');
  const urgencyLevels = result.rows.filter(r => r.type === 'urgency');
  return { categories, urgencyLevels };
}

module.exports = { getClientByApiKey, getClientCategories };