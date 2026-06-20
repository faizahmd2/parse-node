import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/router';

const REFRESH_INTERVAL = 30;

export default function Showcase() {
  const router = useRouter();
  const fileRef = useRef();

  // Timer
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [lastRefresh, setLastRefresh] = useState(null);

  // Queue
  const [queueStats, setQueueStats] = useState({ waiting: 0, active: 0, completed: 0, failed: 0, max: 10 });

  // File ingestion
  const [dragging, setDragging] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [uploadError, setUploadError] = useState('');

  // Message routing
  const [apiKey, setApiKey] = useState('');
  const [channel, setChannel] = useState('email');
  const [msgForm, setMsgForm] = useState({ from: '', subject: '', body: '' });
  const [msgResult, setMsgResult] = useState(null);
  const [msgLoading, setMsgLoading] = useState(false);

  // Search
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const statsRes = await fetch('/api/queue/stats');
      setQueueStats(await statsRes.json());
      setLastRefresh(new Date());
      setCountdown(REFRESH_INTERVAL);
    } catch {}
  }, []);

  // Auto refresh countdown
  useEffect(() => {
    refresh();
    const tick = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { refresh(); return REFRESH_INTERVAL; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [refresh]);

  // Poll active jobs
  useEffect(() => {
    const active = jobs.filter(j => j.status !== 'done' && j.status !== 'failed');
    if (active.length === 0) return;
    const interval = setInterval(async () => {
      const updated = await Promise.all(jobs.map(async j => {
        if (j.status === 'done' || j.status === 'failed') return j;
        try {
          const res = await fetch(`/api/jobs/${j.jobId}`);
          const data = await res.json();
          return { ...j, status: data.status, stage: data.stage, progress: data.progress || 0, hasText: data.has_text };
        } catch { return j; }
      }));
      setJobs(updated);
    }, 2000);
    return () => clearInterval(interval);
  }, [jobs]);

  async function uploadFile(file) {
    setUploadError('');
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) { setUploadError(data.error); return; }
    setJobs(prev => [...prev, {
      jobId: data.jobId, filename: file.name,
      status: 'queued', stage: null, progress: 0, hasText: false,
    }]);
  }

  function onDrop(e) {
    e.preventDefault(); setDragging(false);
    Array.from(e.dataTransfer.files).forEach(uploadFile);
  }

  async function sendMessage() {
    if (!msgForm.body || !apiKey) return;
    setMsgLoading(true); setMsgResult(null);
    const res = await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ channel, ...msgForm }),
    });
    const data = await res.json();
    if (!res.ok) { setMsgResult({ error: data.error }); setMsgLoading(false); return; }

    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      const r = await fetch(`/api/message/${data.messageId}`, { headers: { 'X-API-Key': apiKey } });
      const msg = await r.json();
      if (msg.status === 'done' || msg.status === 'failed' || attempts > 30) {
        clearInterval(poll); setMsgResult(msg); setMsgLoading(false);
      }
    }, 1500);
  }

  async function doSearch() {
    if (!query.trim()) return;
    setSearching(true); setSearchResults(null);
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    setSearchResults(data.results || []);
    setSearching(false);
  }

  function stageColor(status) {
    if (status === 'done') return '#16a34a';
    if (status === 'failed') return '#dc2626';
    return '#4f46e5';
  }

  function stageText(stage, status) {
    if (status === 'done') return '✓ Done';
    if (status === 'failed') return '✗ Failed';
    return { parsing: '⚙ Parsing', chunking: '✂ Chunking', embedding: '🧠 Embedding' }[stage] || '⏳ Queued';
  }

  function downloadExtractedText(jobId) {
    window.location.href = `/api/jobs/${jobId}/download`;
  }

  return (
    <div className="sw-wrap">

      {/* NAV */}
      <div className="sw-nav">
        <span className="sw-nav-logo">AI Ingestion Platform</span>
        <div className="sw-nav-right">
          <button className="sw-nav-btn" onClick={() => router.push('/dashboard')}>Admin Dashboard</button>
        </div>
      </div>

      <div className="sw-page">
        <div className="sw-page-head">
          <h1>Live Demo</h1>
          <p>Interact with the pipeline in real time. Each section demonstrates a different capability.</p>
        </div>

        {/* REFRESH BAR */}
        <div className="sw-refresh-bar">
          <div className="sw-refresh-left">
            <span className={`sw-dot ${queueStats.active > 0 ? 'active' : ''}`} />
            <span>Queue: <strong>{queueStats.active}</strong> active · <strong>{queueStats.waiting}</strong> waiting · <strong>{queueStats.completed}</strong> completed</span>
            <span className="sw-capacity">({queueStats.waiting + queueStats.active}/{queueStats.max} capacity)</span>
          </div>
          <div className="sw-refresh-right">
            <span className="sw-timer">Last refresh: {lastRefresh && lastRefresh.toLocaleTimeString()} · next in {countdown}s</span>
            <button className="sw-refresh-btn" onClick={refresh}>↻ Refresh now</button>
          </div>
        </div>

        {/* SECTION 1: FILE INGESTION */}
        <div className="sw-section">
          <div className="sw-section-head">
            <div className="sw-section-num">01</div>
            <div>
              <h2>Document Ingestion</h2>
              <p>Upload a file — including scanned or handwritten images. It enters a distributed queue, gets parsed (MarkItDown for documents, OCR for images), split into semantic chunks, and embedded into pgvector for search. Extracted text is downloadable as soon as parsing finishes.</p>
            </div>
          </div>

          <div
            className={`sw-dropzone ${dragging ? 'drag' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current.click()}
          >
            <input ref={fileRef} type="file" multiple
              accept=".pdf,.docx,.pptx,.html,.txt,.jpg,.jpeg,.png,.webp,.bmp,.tiff,.tif"
              style={{ display: 'none' }}
              onChange={e => { Array.from(e.target.files).forEach(uploadFile); e.target.value = ''; }}
            />
            <div className="sw-drop-icon">↑</div>
            <p>Drop files here or click to upload</p>
            <span>PDF · DOCX · PPTX · HTML · TXT · Images (printed & handwritten) · Max {queueStats.max} in queue</span>
          </div>

          {uploadError && <div className="sw-alert">{uploadError}</div>}

          {jobs.length > 0 && (
            <div className="sw-job-list">
              {jobs.map(j => (
                <div key={j.jobId} className="sw-job">
                  <div className="sw-job-row">
                    <span className="sw-job-name">{j.filename}</span>
                    <span style={{ color: stageColor(j.status), fontSize: 12, fontWeight: 600 }}>
                      {stageText(j.stage, j.status)}
                    </span>
                    <span style={{ fontSize: 12, color: '#64748b' }}>{j.progress || 0}%</span>
                    {j.hasText && (
                      <button className="sw-download-btn" onClick={() => downloadExtractedText(j.jobId)}>
                        ⬇ Text
                      </button>
                    )}
                  </div>
                  <div className="sw-bar-bg">
                    <div className="sw-bar-fill" style={{
                      width: `${j.progress || 0}%`,
                      background: stageColor(j.status),
                    }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* SECTION 2: SEMANTIC SEARCH */}
        <div className="sw-section">
          <div className="sw-section-head">
            <div className="sw-section-num">02</div>
            <div>
              <h2>Semantic Search</h2>
              <p>Query the vector store using natural language. Results are ranked by cosine similarity — finds meaning, not just keywords.</p>
            </div>
          </div>

          <div className="sw-inline">
            <input
              className="sw-input"
              placeholder="e.g. backend development experience with Node.js..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doSearch()}
            />
            <button className="sw-btn" onClick={doSearch} disabled={searching}>
              {searching ? 'Searching...' : 'Search'}
            </button>
          </div>

          {searchResults && searchResults.length === 0 && (
            <div className="sw-empty">No results. Try uploading a document first.</div>
          )}

          {searchResults && searchResults.map((r, i) => (
            <div key={i} className="sw-result">
              <div className="sw-result-meta">
                <span className="sw-result-file">{r.filename}</span>
                <span className="sw-result-score">{(r.similarity * 100).toFixed(1)}% match</span>
              </div>
              <p>{r.content.substring(0, 250)}{r.content.length > 250 ? '...' : ''}</p>
            </div>
          ))}
        </div>

        {/* SECTION 3: MESSAGE ROUTING */}
        <div className="sw-section">
          <div className="sw-section-head">
            <div className="sw-section-num">03</div>
            <div>
              <h2>Intelligent Message Routing</h2>
              <p>Submit a message from any channel. The AI classifier determines intent and urgency using your client's taxonomy, then routes to the configured destination.</p>
            </div>
          </div>

          <div className="sw-field">
            <label>API Key <span>(from admin dashboard → client)</span></label>
            <input className="sw-input" placeholder="key_..."
              value={apiKey} onChange={e => setApiKey(e.target.value)} />
          </div>

          <div className="sw-field">
            <label>Channel</label>
            <div className="sw-channels">
              {['email', 'sms', 'whatsapp', 'custom'].map(c => (
                <button key={c}
                  className={`sw-channel ${channel === c ? 'active' : ''}`}
                  onClick={() => setChannel(c)}>
                  {c.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="sw-field">
            <label>From</label>
            <input className="sw-input" placeholder="sender@example.com or +91..."
              value={msgForm.from} onChange={e => setMsgForm({ ...msgForm, from: e.target.value })} />
          </div>

          {channel === 'email' && (
            <div className="sw-field">
              <label>Subject</label>
              <input className="sw-input" placeholder="Email subject..."
                value={msgForm.subject} onChange={e => setMsgForm({ ...msgForm, subject: e.target.value })} />
            </div>
          )}

          <div className="sw-field">
            <label>Message Body</label>
            <textarea className="sw-textarea" rows={4}
              placeholder="Type the message content here..."
              value={msgForm.body} onChange={e => setMsgForm({ ...msgForm, body: e.target.value })} />
          </div>

          <button className="sw-btn full" onClick={sendMessage}
            disabled={msgLoading || !msgForm.body || !apiKey}>
            {msgLoading ? 'Classifying and routing...' : 'Submit Message →'}
          </button>

          {msgResult && !msgResult.error && (
            <div className="sw-msg-result">
              <div className="sw-msg-row">
                <span className="sw-msg-label">Category</span>
                <span className="sw-msg-val">{msgResult.classification?.category || '—'}</span>
                <span className="sw-msg-conf">
                  {msgResult.classification?.category_confidence
                    ? `${(msgResult.classification.category_confidence * 100).toFixed(0)}% confidence`
                    : ''}
                </span>
              </div>
              <div className="sw-msg-row">
                <span className="sw-msg-label">Urgency</span>
                <span className={`sw-msg-val ${msgResult.classification?.urgency === 'high' ? 'high' : ''}`}>
                  {msgResult.classification?.urgency || '—'}
                </span>
                <span className="sw-msg-conf">
                  {msgResult.classification?.urgency_confidence
                    ? `${(msgResult.classification.urgency_confidence * 100).toFixed(0)}% confidence`
                    : ''}
                </span>
              </div>
              <div className="sw-msg-row">
                <span className="sw-msg-label">Status</span>
                <span className={`sw-msg-val ${msgResult.routing_status === 'sent' ? 'sent' : ''}`}>
                  {msgResult.routing_status || msgResult.status}
                </span>
              </div>
            </div>
          )}

          {msgResult?.error && <div className="sw-alert">{msgResult.error}</div>}
        </div>

      </div>
    </div>
  );
}