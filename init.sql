-- CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued, processing, done, failed
  stage TEXT,                             -- parsing, chunking, embedding
  progress INT DEFAULT 0,
  error TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES jobs(id),
  filename TEXT,
  content TEXT,           -- full markdown from MarkItDown
  markdown_content TEXT,           -- formatted
  created_at TIMESTAMP DEFAULT now()
);
