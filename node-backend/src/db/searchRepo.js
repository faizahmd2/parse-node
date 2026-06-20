const pool = require('./pool');

async function searchChunks(embedding, limit = 5) {
  const vectorStr = `[${embedding.join(',')}]`;
  const result = await pool.query(
    `SELECT c.id, c.content, d.filename, 
            1 - (c.embedding <=> $1) AS similarity
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     ORDER BY c.embedding <=> $1
     LIMIT $2`,
    [vectorStr, limit]
  );
  return result.rows;
}

module.exports = { searchChunks };