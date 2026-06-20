const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../db/pool');

function createOAuthClient() {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl() {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',      // gives us refresh_token
    prompt: 'consent',           // forces refresh_token every time
    scope: [
        'openid',
        'email',
        'profile',
        'https://www.googleapis.com/auth/gmail.readonly'
    ],
  });
}

async function exchangeCodeForTokens(code) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  // Return both tokens AND the configured client
  client.setCredentials(tokens);
  return { tokens, client };
}

async function getAuthenticatedClient(refreshToken) {
  const client = createOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

async function getGmailClient(refreshToken) {
  const auth = await getAuthenticatedClient(refreshToken);
  return google.gmail({ version: 'v1', auth });
}

async function registerGmailWatch(refreshToken) {
  const gmail = await getGmailClient(refreshToken);
  const res = await gmail.users.watch({
    userId: 'me',
    requestBody: {
      topicName: process.env.GOOGLE_PUBSUB_TOPIC,
      labelIds: ['INBOX'],
    },
  });
  // Returns { historyId, expiration } - expiration is ~7 days from now
  return res.data;
}

async function fetchEmailById(refreshToken, emailId) {
  const gmail = await getGmailClient(refreshToken);
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: emailId,
    format: 'full',
  });
  return parseEmailPayload(res.data);
}

async function fetchEmailsByHistoryId(refreshToken, startHistoryId) {
  const gmail = await getGmailClient(refreshToken);
  try {
    const res = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
    });

    const history = res.data.history || [];
    const emailIds = [];

    for (const record of history) {
      for (const msg of record.messagesAdded || []) {
        emailIds.push(msg.message.id);
      }
    }
    return emailIds;
  } catch (err) {
    // historyId expired (rare) - return empty, next watch will reset it
    if (err.code === 404) return [];
    throw err;
  }
}

function parseEmailPayload(data) {
  const headers = data.payload.headers;
  const get = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

  const subject = get('Subject');
  const from = get('From');
  const to = get('To');

  const body = extractBody(data.payload);

  return { subject, from, to, body, gmailId: data.id };
}

function extractBody(payload) {
  // Handle multipart emails
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
    }
    // Fallback to HTML part if no plain text
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
        return stripHtml(html);
      }
    }
  }
  // Single part email
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  return '';
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>.*?<\/style>/gsi, '')
    .replace(/<script[^>]*>.*?<\/script>/gsi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  registerGmailWatch,
  fetchEmailById,
  fetchEmailsByHistoryId,
};