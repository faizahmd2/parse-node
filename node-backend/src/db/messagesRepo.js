const pool = require('./pool');

async function createMessage({ clientId, channel, from, to, subject, body, metadata }) {
  const result = await pool.query(
    `INSERT INTO messages (client_id, channel, from_identifier, to_identifier, subject, body, metadata, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued') RETURNING *`,
    [clientId, channel, from, to, subject, body, metadata || {}]
  );
  return result.rows[0];
}

async function updateMessage(id, fields) {
  const sets = [];
  const values = [];
  let i = 1;

  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = $${i}`);
    values.push(typeof value === 'object' && value !== null ? JSON.stringify(value) : value);
    i++;
  }
  values.push(id);

  await pool.query(
    `UPDATE messages SET ${sets.join(', ')}, updated_at = now() WHERE id = $${i}`,
    values
  );
}

async function getMessage(id) {
  const result = await pool.query('SELECT * FROM messages WHERE id = $1', [id]);
  return result.rows[0];
}

module.exports = { createMessage, updateMessage, getMessage };