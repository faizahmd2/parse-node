require('dotenv').config();
const express = require('express');
const next = require('next');
const session = require('express-session');
const path = require('path');

// Routes
const uploadRoutes = require('./api/uploadRoutes');
const messageRoutes = require('./api/messageRoutes');
const gmailRoutes = require('./api/gmailRoutes');
const adminRoutes = require('./api/adminRoutes');

// Workers — start alongside server
require('./workers/ingestionWorker');
require('./workers/messageWorker');
require('./cron/renewGmailWatch');

const dev = process.env.NODE_ENV !== 'production';
const nextApp = next({ dev, dir: path.join(__dirname, 'admin') });
const handle = nextApp.getRequestHandler();

nextApp.prepare().then(() => {
  const app = express();

  app.use(express.json());
  app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
  }));

  // API routes
  app.use('/api', uploadRoutes);
  app.use('/api', messageRoutes);
  app.use('/', gmailRoutes);
  app.use('/admin-api', adminRoutes);

  // Next.js handles everything else (admin UI)
  app.use((req, res) => {
    return handle(req, res);
  });

  app.listen(2912, () => {
    console.log('Server running on port 2912');
  });
});