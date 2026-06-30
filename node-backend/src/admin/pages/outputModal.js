import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function DocumentViewerModal({ jobId, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState(null); // { filename, markdown, text }
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    fetch(`/api/jobs/${jobId}/view`)
      .then((res) => {
        if (!res.ok) throw new Error('Could not load this document');
        return res.json();
      })
      .then((json) => { if (!cancelled) setData(json); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [jobId]);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hasMarkdown = Boolean(data?.markdown);
  const displayContent = hasMarkdown ? data.markdown : (data?.text || '');

  const copyToClipboard = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(displayContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API can fail on plain-http Cloudflare Tunnel URLs (non-secure
      // context) — fall back to selecting the content so Cmd/Ctrl+C still works.
      const el = document.getElementById('dv-content');
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }, [displayContent]);

  function downloadFile(format) {
    window.location.href = `/api/jobs/${jobId}/download?format=${format}`;
  }

  return (
    <div className="dv-backdrop" onClick={onClose}>
      <div className="dv-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dv-header">
          <div className="dv-header-info">
            <span className="dv-filename">{data?.filename || 'Document'}</span>
            {!loading && !error && (
              <span className={`dv-badge ${hasMarkdown ? 'formatted' : 'plain'}`}>
                {hasMarkdown ? '✨ AI-formatted' : 'Plain text'}
              </span>
            )}
          </div>
          <button className="dv-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="dv-body">
          {loading && <div className="dv-state">Loading…</div>}
          {error && <div className="dv-state dv-error">{error}</div>}
          {!loading && !error && (
            hasMarkdown ? (
              <div className="dv-markdown" id="dv-content">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    table: ({ node, ...props }) => (
                      <div className="dv-table-wrap"><table {...props} /></div>
                    ),
                  }}
                >
                  {data.markdown}
                </ReactMarkdown>
              </div>
            ) : (
              <pre className="dv-plain" id="dv-content">{data.text}</pre>
            )
          )}
        </div>

        <div className="dv-footer">
          <button className="dv-btn dv-btn-primary" onClick={copyToClipboard} disabled={loading || !!error}>
            {copied ? '✓ Copied' : '⧉ Copy'}
          </button>
          <div className="dv-downloads">
            <button className="dv-btn" onClick={() => downloadFile('md')} disabled={!hasMarkdown} title={!hasMarkdown ? 'No formatted version available for this document' : ''}>
              ⬇ .md
            </button>
            <button className="dv-btn" onClick={() => downloadFile('txt')} disabled={loading || !!error}>
              ⬇ .txt
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}