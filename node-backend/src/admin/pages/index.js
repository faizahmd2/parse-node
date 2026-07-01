import { useState, useEffect, useRef, useCallback } from 'react';
import DocumentViewerModal from './outputModal';

const POLL_INTERVAL = 2000;
const QUEUE_REFRESH_INTERVAL = 30;

export default function Showcase() {
  const fileRef = useRef();

  const [countdown, setCountdown] = useState(QUEUE_REFRESH_INTERVAL);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [queueStats, setQueueStats] = useState({ waiting: 0, active: 0, completed: 0, failed: 0, max: 10 });

  const [dragging, setDragging] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [uploadError, setUploadError] = useState('');
  const [viewingJobId, setViewingJobId] = useState(null);

  const refreshQueue = useCallback(async () => {
    try {
      const res = await fetch('/api/queue/stats');
      setQueueStats(await res.json());
      setLastRefresh(new Date());
      setCountdown(QUEUE_REFRESH_INTERVAL);
    } catch {}
  }, []);

  useEffect(() => {
    refreshQueue();
    const tick = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { refreshQueue(); return QUEUE_REFRESH_INTERVAL; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [refreshQueue]);

  // Poll only jobs that are still in flight
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
    }, POLL_INTERVAL);
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
      jobId: data.jobId,
      filename: file.name,
      status: 'queued',
      stage: null,
      progress: 0,
      hasText: false,
    }]);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    Array.from(e.dataTransfer.files).forEach(uploadFile);
  }

  function stageColor(status) {
    if (status === 'done') return 'var(--color-success)';
    if (status === 'failed') return 'var(--color-error)';
    return 'var(--color-accent)';
  }

  function stageLabel(stage, status) {
    if (status === 'done') return '✓ Done';
    if (status === 'failed') return '✗ Failed';
    return { parsing: '⚙ Parsing', chunking: '✂ Chunking', embedding: '⬡ Embedding' }[stage] || '· Queued';
  }

  function downloadText(jobId) {
    window.location.href = `/api/jobs/${jobId}/download`;
  }

  return (
    <div className="page">

      <header className="header">
        <span className="logo">AI Ingestion</span>
        <div className="queue-status">
          <span className={`pulse ${queueStats.active > 0 ? 'live' : ''}`} />
          <span className="queue-text">
            {queueStats.active} active · {queueStats.waiting} waiting · {queueStats.completed} done
          </span>
          <span className="queue-capacity">
            ({queueStats.waiting + queueStats.active}/{queueStats.max})
          </span>
          <button className="btn-ghost" onClick={refreshQueue} title="Refresh queue stats">
            ↻ {lastRefresh ? `${countdown}s` : ''}
          </button>
        </div>
      </header>

      <main className="main">
        <div
          className={`dropzone ${dragging ? 'drag' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current.click()}
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".pdf,.docx,.pptx,.html,.txt,.jpg,.jpeg,.png,.webp,.bmp,.tiff,.tif"
            style={{ display: 'none' }}
            onChange={e => { Array.from(e.target.files).forEach(uploadFile); e.target.value = ''; }}
          />
          <div className="drop-icon">↑</div>
          <p className="drop-label">Drop files or click to upload</p>
          <span className="drop-hint">PDF · DOCX · PPTX · TXT · Images — printed, handwritten, any language</span>
        </div>

        {uploadError && <div className="alert">{uploadError}</div>}

        {jobs.length > 0 && (
          <ul className="job-list">
            {jobs.map(j => (
              <li key={j.jobId} className="job">
                <div className="job-row">
                  <span className="job-name" title={j.filename}>{j.filename}</span>
                  <span className="job-stage" style={{ color: stageColor(j.status) }}>
                    {stageLabel(j.stage, j.status)}
                  </span>
                  <span className="job-pct">{j.progress || 0}%</span>
                  {j.hasText && (
                    <div className="job-actions">
                      <button className="btn-action" onClick={() => setViewingJobId(j.jobId)}>View</button>
                      <button className="btn-action" onClick={() => downloadText(j.jobId)}>Download</button>
                    </div>
                  )}
                </div>
                <div className="bar-bg">
                  <div
                    className="bar-fill"
                    style={{ width: `${j.progress || 0}%`, background: stageColor(j.status) }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>

      {viewingJobId && (
        <DocumentViewerModal jobId={viewingJobId} onClose={() => setViewingJobId(null)} />
      )}
    </div>
  );
}