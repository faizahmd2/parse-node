const pool = require('./pool');

async function findMatchingRoute(clientId, classification) {
  const result = await pool.query(
    `SELECT rr.*, d.name as destination_name, d.type as destination_type, d.config as destination_config
     FROM routing_rules rr
     JOIN destinations d ON d.id = rr.destination_id
     WHERE rr.client_id = $1 AND rr.active = true AND d.active = true
     ORDER BY rr.priority ASC`,
    [clientId]
  );

  for (const rule of result.rows) {
    if (matchesCondition(classification, rule.condition)) {
      return rule;
    }
  }
  return null;
}

function matchesCondition(classification, condition) {
  return Object.entries(condition).every(
    ([key, value]) => classification[key] === value
  );
}

module.exports = { findMatchingRoute };