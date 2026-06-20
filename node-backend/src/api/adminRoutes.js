const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAdminSession } = require('../middleware/adminAuth');

// Login
router.post('/login', async (req, res) => {
  const { password } = req.body;
  console.log('Admin login attempt',password, process.env.ADMIN_PASSWORD);
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  req.session.admin = true;
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// All routes below require admin session
router.use(requireAdminSession);

// --- Clients ---
router.get('/clients', async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, api_key, gmail_email, active, created_at FROM clients ORDER BY created_at DESC'
  );
  res.json(result.rows);
});

router.post('/clients', async (req, res) => {
  const { name } = req.body;
  const apiKey = `key_${require('crypto').randomBytes(16).toString('hex')}`;
  const result = await pool.query(
    'INSERT INTO clients (name, api_key) VALUES ($1, $2) RETURNING *',
    [name, apiKey]
  );
  res.json(result.rows[0]);
});

router.patch('/clients/:id', async (req, res) => {
  const { name, active } = req.body;
  await pool.query(
    'UPDATE clients SET name = COALESCE($1, name), active = COALESCE($2, active) WHERE id = $3',
    [name, active, req.params.id]
  );
  res.json({ ok: true });
});

router.delete('/clients/:id', async (req, res) => {
  await pool.query('DELETE FROM clients WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- Categories ---
router.get('/clients/:clientId/categories', async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM client_categories WHERE client_id = $1 ORDER BY type, value',
    [req.params.clientId]
  );
  res.json(result.rows);
});

router.post('/clients/:clientId/categories', async (req, res) => {
  const { type, value, description } = req.body;
  const result = await pool.query(
    'INSERT INTO client_categories (client_id, type, value, description) VALUES ($1, $2, $3, $4) RETURNING *',
    [req.params.clientId, type, value, description]
  );
  res.json(result.rows[0]);
});

router.delete('/categories/:id', async (req, res) => {
  await pool.query('DELETE FROM client_categories WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- Destinations ---
router.get('/clients/:clientId/destinations', async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM destinations WHERE client_id = $1',
    [req.params.clientId]
  );
  res.json(result.rows);
});

router.post('/clients/:clientId/destinations', async (req, res) => {
  const { name, type, config } = req.body;
  const result = await pool.query(
    'INSERT INTO destinations (client_id, name, type, config) VALUES ($1, $2, $3, $4) RETURNING *',
    [req.params.clientId, name, type, config]
  );
  res.json(result.rows[0]);
});

router.delete('/destinations/:id', async (req, res) => {
  await pool.query('DELETE FROM destinations WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- Routing Rules ---
router.get('/clients/:clientId/rules', async (req, res) => {
  const result = await pool.query(
    `SELECT rr.*, d.name as destination_name 
     FROM routing_rules rr
     JOIN destinations d ON d.id = rr.destination_id
     WHERE rr.client_id = $1 ORDER BY rr.priority`,
    [req.params.clientId]
  );
  res.json(result.rows);
});

router.post('/clients/:clientId/rules', async (req, res) => {
  const { priority, condition, destination_id } = req.body;
  const result = await pool.query(
    'INSERT INTO routing_rules (client_id, priority, condition, destination_id) VALUES ($1, $2, $3, $4) RETURNING *',
    [req.params.clientId, priority, condition, destination_id]
  );
  res.json(result.rows[0]);
});

router.delete('/rules/:id', async (req, res) => {
  await pool.query('DELETE FROM routing_rules WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- Activity (successful routes + errors only) ---
router.get('/clients/:clientId/activity', async (req, res) => {
  const result = await pool.query(
    `SELECT id, channel, from_identifier, subject, classification,
            routing_status, status, created_at
     FROM messages
     WHERE client_id = $1
     AND (routing_status = 'sent' OR status = 'failed')
     ORDER BY created_at DESC LIMIT 50`,
    [req.params.clientId]
  );
  res.json(result.rows);
});

// --- Gmail OAuth link generator ---
router.get('/clients/:clientId/gmail-link', async (req, res) => {
  const result = await pool.query('SELECT api_key FROM clients WHERE id = $1', [req.params.clientId]);
  const client = result.rows[0];
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const link = `https://ai-platform.faizweb.in/auth/gmail?api_key=${client.api_key}`;
  res.json({ link });
});

module.exports = router;