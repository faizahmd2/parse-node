require('dotenv').config();
const express = require('express');
const next = require('next');
const path = require('path');

// Routes
const uploadRoutes = require('./api/uploadRoutes');

// Workers — start alongside server
require('./workers/ingestionWorker');

const dev = process.env.NODE_ENV !== 'production';
const nextApp = next({ dev, dir: path.join(__dirname, 'admin') });
const handle = nextApp.getRequestHandler();

nextApp.prepare().then(() => {
  const app = express();

  app.use(express.json());

  // API routes
  app.use('/api', uploadRoutes);

  // Next.js handles everything else (admin UI)
  app.use((req, res) => {
    return handle(req, res);
  });

  app.listen(2912, () => {
    console.log('Server running on port 2912');
  });
});