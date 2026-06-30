const pool = require('./pool');

async function createDocument({ jobId, filename, content }) {
  const result = await pool.query(
    `INSERT INTO documents (job_id, filename, content) VALUES ($1, $2, $3) RETURNING *`,
    [jobId, filename, content]
  );
  return result.rows[0];
}

async function updateDocumentMarkdown(documentId, markdown) {
  const result = await pool.query(
    `UPDATE documents SET markdown_content = $1 WHERE id = $2 RETURNING *`,
    [markdown, documentId]
  );
  return result.rows[0];
}

async function getDocumentByJobId(jobId) {
  const result = await pool.query(
    `SELECT filename, content, markdown_content FROM documents WHERE job_id = $1`,
    [jobId]
  );
  return result.rows[0];
}

module.exports = { createDocument, getDocumentByJobId, updateDocumentMarkdown };