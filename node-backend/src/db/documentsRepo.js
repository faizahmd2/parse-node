const pool = require('./pool');

async function createDocument({ jobId, filename, content }) {
  const result = await pool.query(
    `INSERT INTO documents (job_id, filename, content) VALUES ($1, $2, $3) RETURNING *`,
    [jobId, filename, content]
  );
  return result.rows[0];
}

async function getDocumentByJobId(jobId) {
  const result = await pool.query(
    `SELECT filename, content FROM documents WHERE job_id = $1`,
    [jobId]
  );
  return result.rows[0];
}

async function insertChunks(documentId, chunksWithEmbeddings) {
  for (const { content, embedding } of chunksWithEmbeddings) {
    const vectorStr = `[${embedding.join(',')}]`; // pgvector format
    await pool.query(
      `INSERT INTO chunks (document_id, content, embedding) VALUES ($1, $2, $3)`,
      [documentId, content, vectorStr]
    );
  }
}

module.exports = { createDocument, insertChunks, getDocumentByJobId };