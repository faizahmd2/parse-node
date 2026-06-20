const pool = require('./pool');

async function createJob({ filename, filePath }) {
  const result = await pool.query(
    `INSERT INTO jobs (filename, file_path, status)
     VALUES ($1, $2, 'queued') RETURNING *`,
    [filename, filePath]
  );
  return result.rows[0];
}

async function updateJobStatus(id, { status, stage, progress, error }) {
  await pool.query(
    `UPDATE jobs
     SET status = COALESCE($2, status),
         stage = COALESCE($3, stage),
         progress = COALESCE($4, progress),
         error = COALESCE($5, error),
         updated_at = now()
     WHERE id = $1`,
    [id, status, stage, progress, error]
  );
}

async function getJob(id) {
  const result = await pool.query(
    `SELECT j.*, (d.id IS NOT NULL) AS has_text
     FROM jobs j
     LEFT JOIN documents d ON d.job_id = j.id
     WHERE j.id = $1`,
    [id]
  );
  return result.rows[0];
}

module.exports = { createJob, updateJobStatus, getJob };