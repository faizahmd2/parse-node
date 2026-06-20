const cron = require('node-cron');
const pool = require('../db/pool');
const { registerGmailWatch } = require('../services/gmailService');

// Run daily at 2am - renew watches expiring within 24hrs
cron.schedule('0 2 * * *', async () => {
  console.log('Checking Gmail watch renewals...');
  
  const result = await pool.query(
    `SELECT * FROM clients 
     WHERE gmail_refresh_token IS NOT NULL 
     AND gmail_watch_expiry < now() + interval '24 hours'
     AND active = true`
  );

  for (const client of result.rows) {
    try {
      const watch = await registerGmailWatch(client.gmail_refresh_token);
      await pool.query(
        `UPDATE clients SET 
          gmail_history_id = $1,
          gmail_watch_expiry = to_timestamp($2::double precision / 1000)
         WHERE id = $3`,
        [watch.historyId, watch.expiration, client.id]
      );
      console.log(`Renewed watch for ${client.gmail_email}`);
    } catch (err) {
      console.error(`Failed to renew watch for ${client.gmail_email}:`, err.message);
    }
  }
});