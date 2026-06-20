CREATE EXTENSION IF NOT EXISTS vector;

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
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id),
  content TEXT,
  embedding vector(384),  -- 384 = dimension for all-MiniLM-L6-v2
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  api_key TEXT UNIQUE NOT NULL,  -- client authenticates requests with this
  gmail_refresh_token TEXT NULL,
  gmail_email TEXT NULL,
  gmail_history_id TEXT NULL,
  gmail_watch_expiry TIMESTAMP NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT now()
);

-- Client-defined taxonomy for classification
CREATE TABLE client_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id),
  type TEXT NOT NULL,        -- 'category' or 'urgency'
  value TEXT NOT NULL,       -- e.g. 'billing issue', 'high'
  description TEXT,          -- helps zero-shot classifier understand context
  UNIQUE(client_id, type, value)
);

-- Reusable output destinations
CREATE TABLE destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id),
  name TEXT NOT NULL,         -- e.g. "billing-slack", "support-email"
  type TEXT NOT NULL,         -- webhook, email, slack, sms
  config JSONB NOT NULL,      -- {"url": "...", "headers": {...}} or {"email": "..."}
  active BOOLEAN DEFAULT true,
  UNIQUE(client_id, name)
);

-- Dynamic routing rules per client
CREATE TABLE routing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id),
  priority INT NOT NULL,
  condition JSONB NOT NULL,        -- {"category": "billing issue", "urgency": "high"}
  destination_id UUID REFERENCES destinations(id),
  active BOOLEAN DEFAULT true
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id),
  channel TEXT NOT NULL,
  from_identifier TEXT,
  to_identifier TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  embedding vector(384),
  classification JSONB,
  routed_to UUID REFERENCES destinations(id),
  routing_status TEXT DEFAULT 'pending',  -- pending, sent, failed
  status TEXT DEFAULT 'queued',
  metadata JSONB,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- For indexing the embedding vector for faster similarity search
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
