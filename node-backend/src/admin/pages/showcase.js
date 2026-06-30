import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/router';
import DocumentViewerModal from './outputModal';

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
  const [viewingJobId, setViewingJobId] = useState(null);

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
              <p>Upload a file</p>
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
                      <>
                        <button className="sw-view-btn" onClick={() => setViewingJobId(j.jobId)}>
                          👁 View
                        </button>
                        <button className="sw-download-btn" onClick={() => downloadExtractedText(j.jobId)}>
                          ⬇ Text
                        </button>
                      </>
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
      </div>

      {viewingJobId && (
        <DocumentViewerModal jobId={viewingJobId} onClose={() => setViewingJobId(null)} />
      )}
    </div>
  );
}