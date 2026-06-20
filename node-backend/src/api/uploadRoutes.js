const fs = require('fs');
const express = require('express');
const router = express.Router();
const ingestionQueue = require('../queue/ingestionQueue');
const { createJob, getJob } = require('../db/jobsRepo');
const { getDocumentByJobId } = require('../db/documentsRepo');
const multer = require('multer');
const { embedTexts } = require('../services/pythonService');
const { searchChunks } = require('../db/searchRepo');
const MAX_QUEUE_SIZE = process.env.MAX_QUEUE_SIZE || 10;
const path = require('path');

const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.docx', '.pptx', '.html', '.htm', '.txt',
  '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif',
]);

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new Error(`Unsupported file type: ${ext || 'unknown'}`));
    }
    cb(null, true);
  },
});

// multer's fileFilter errors land in next(err); wrap so the route always returns clean JSON
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

router.post('/upload', uploadSingle, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Check queue depth
  const waiting = await ingestionQueue.getWaitingCount();
  const active = await ingestionQueue.getActiveCount();
  const total = waiting + active;

  if (total >= MAX_QUEUE_SIZE) {
    fs.unlinkSync(req.file.path); // delete uploaded file immediately
    return res.status(429).json({
      error: `Queue is full (${MAX_QUEUE_SIZE} max). Please try again shortly.`,
      queue_size: total,
    });
  }

  const job = await createJob({
    filename: req.file.originalname,
    filePath: req.file.path,
  });

  await ingestionQueue.add('process-document', {
    jobId: job.id,
    filePath: req.file.path,
    filename: req.file.originalname,
  });

  res.json({ jobId: job.id, status: 'queued', queue_position: total + 1 });
});

router.get('/queue/stats', async (req, res) => {
  const [waiting, active, completed, failed] = await Promise.all([
    ingestionQueue.getWaitingCount(),
    ingestionQueue.getActiveCount(),
    ingestionQueue.getCompletedCount(),
    ingestionQueue.getFailedCount(),
  ]);
  res.json({ waiting, active, completed, failed, max: MAX_QUEUE_SIZE });
});

// Direct download of extracted text — ready as soon as the parse stage finishes,
// no need to wait for chunking/embedding to complete.
router.get('/jobs/:id/download', async (req, res) => {
  const doc = await getDocumentByJobId(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Text not ready yet' });

  const safeName = doc.filename.replace(/\.[^/.]+$/, '') + '.txt';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.send(doc.content);
});

router.get('/jobs/:id', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

router.post('/search', async (req, res) => {
  const { query, limit } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });
  const ALLOWED_MATCH = 90 // 90% & above

  const [embedding] = await embedTexts([query]);
  const results = await searchChunks(embedding, limit || 5);
  const data = results.filter(d=> {
    if(d.similarity * 100 >= ALLOWED_MATCH) {
      return d;
    }

    return false;
  })

  res.json({ query, results: data });
});

module.exports = router;