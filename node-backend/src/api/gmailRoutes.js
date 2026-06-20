const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const messageQueue = require('../queue/messageQueue');
const { createMessage } = require('../db/messagesRepo');
const {
  getAuthUrl,
  exchangeCodeForTokens,
  fetchEmailsByHistoryId,
  fetchEmailById,
} = require('../services/gmailService');
const { google } = require('googleapis');

// Step 1: Redirect user to Google OAuth
router.get('/auth/gmail', (req, res) => {
  // In real multi-user: attach client_id to state param
  // For now: state = client api_key so we know who's connecting
  const state = req.query.api_key || '';
  const url = getAuthUrl() + `&state=${encodeURIComponent(state)}`;
  res.redirect(url);
});

// Step 2: Google redirects back here with code
router.get('/auth/gmail/callback', async (req, res) => {
  const { code, state } = req.query;
  const apiKey = decodeURIComponent(state || '');

  try {
    const { tokens, client } = await exchangeCodeForTokens(code);
    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      return res.status(400).send(`
        <h2>No refresh token received</h2>
        <p>Go to <a href="https://myaccount.google.com/permissions">Google Account Permissions</a>,
        revoke access for this app, then try connecting again.</p>
      `);
    }

    // Decode email from id_token — no extra API call needed
    // id_token is a JWT, middle part is base64 encoded claims
    console.log('ID Token:', tokens);
    const idTokenPayload = JSON.parse(
      Buffer.from(tokens.id_token.split('.')[1], 'base64').toString()
    );
    const gmailEmail = idTokenPayload.email;

    if (!gmailEmail) {
      throw new Error('Could not extract email from id_token');
    }

    // Register Gmail watch using the same client
    const gmail = google.gmail({ version: 'v1', auth: client });
    const watchRes = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: process.env.GOOGLE_PUBSUB_TOPIC,
        labelIds: ['INBOX'],
      },
    });
    const watch = watchRes.data;

    // Store in DB
    await pool.query(
      `UPDATE clients SET
        gmail_refresh_token = $1,
        gmail_email = $2,
        gmail_history_id = $3,
        gmail_watch_expiry = to_timestamp($4::double precision / 1000)
       WHERE api_key = $5`,
      [refreshToken, gmailEmail, watch.historyId, watch.expiration, apiKey]
    );

    res.send(`
      <h2>✅ Gmail connected!</h2>
      <p>Watching: ${gmailEmail}</p>
      <p>Your inbox is now being monitored. You can close this tab.</p>
    `);
  } catch (err) {
    console.error('OAuth callback error:', err.message, err.response?.data);
    res.status(500).send('OAuth failed: ' + err.message);
  }
});

// Step 3: Pub/Sub pushes here when new email arrives
router.post('/webhooks/gmail/pubsub', express.json(), async (req, res) => {
  // Acknowledge immediately - Pub/Sub retries if you don't respond fast
  res.status(200).send('OK');

  try {
    const message = req.body?.message;
    if (!message?.data) return;

    // Pub/Sub data is base64 encoded JSON
    const decoded = JSON.parse(Buffer.from(message.data, 'base64').toString());
    const { emailAddress, historyId } = decoded;

    // Find client by gmail email
    const result = await pool.query(
      'SELECT * FROM clients WHERE gmail_email = $1 AND active = true',
      [emailAddress]
    );
    const client = result.rows[0];
    if (!client) return;

    // Fetch new emails since last known historyId
    const emailIds = await fetchEmailsByHistoryId(
      client.gmail_refresh_token,
      client.gmail_history_id
    );

    // Update historyId immediately so next notification starts from here
    await pool.query(
      'UPDATE clients SET gmail_history_id = $1 WHERE id = $2',
      [historyId, client.id]
    );

    // Process each new email
    for (const emailId of emailIds) {
      const email = await fetchEmailById(client.gmail_refresh_token, emailId);

      if (!email.body || email.body.trim().length === 0) continue;

      const msg = await createMessage({
        clientId: client.id,
        channel: 'email',
        from: email.from,
        to: email.to,
        subject: email.subject,
        body: email.body,
        metadata: { gmail_id: email.gmailId },
      });

      await messageQueue.add('process-message', { messageId: msg.id });
    }
  } catch (err) {
    console.error('Pub/Sub processing error:', err);
  }
});

module.exports = router;