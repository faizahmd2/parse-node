const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST || 'postgres', // ◄ MUST BE 'postgres', NOT 'localhost'
  port: process.env.DB_PORT || 5432,
});

module.exports = pool;