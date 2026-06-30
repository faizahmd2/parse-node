const fs = require('fs');
const express = require('express');
const router = express.Router();
const ingestionQueue = require('../queue/ingestionQueue');
const { createJob, getJob } = require('../db/jobsRepo');
const { getDocumentByJobId } = require('../db/documentsRepo');
const multer = require('multer');
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

  console.log("before",req.file.originalname);

  const job = await createJob({
    filename: req.file.originalname,
    filePath: req.file.path,
  });

  console.log("Afterrrr")

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
// no need to wait for chunking/embedding to complete. ?format=md serves the
// LLM-formatted version if one was successfully generated and fidelity-checked;
// otherwise (or if format=txt) it serves the raw extracted text.
router.get('/jobs/:id/download', async (req, res) => {
  const doc = await getDocumentByJobId(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Text not ready yet' });

  const format = req.query.format === 'md' ? 'md' : 'txt';
  const baseName = doc.filename.replace(/\.[^/.]+$/, '');

  if (format === 'md') {
    if (!doc.markdown_content) {
      return res.status(404).json({ error: 'Formatted markdown not available for this document' });
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.md"`);
    return res.send(doc.markdown_content);
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}.txt"`);
  res.send(doc.content);
});

// JSON payload for the "View" modal — not a download, just the content for
// client-side markdown rendering. Falls back to `text` when no formatted
// markdown exists (LLM call failed, or it failed the fidelity check) so the
// modal always has something to show.
router.get('/jobs/:id/view', async (req, res) => {
  const doc = await getDocumentByJobId(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Text not ready yet' });
  res.json({
    filename: doc.filename,
    markdown: doc.markdown_content || null,
    text: doc.content,
  });
});

router.get('/jobs/:id', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

module.exports = router;