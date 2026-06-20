import { useRouter } from 'next/router';

export default function Landing() {
  const router = useRouter();
  return (
    <div className="land-wrap">
      <div className="land-box">
        <div className="land-badge">Distributed Systems · Applied AI</div>
        <h1 className="land-title">AI Ingestion Platform</h1>
        <p className="land-desc">
          A headless microservice that ingests any document or message,
          processes it through a distributed queue pipeline, generates
          vector embeddings for semantic search, classifies intent and
          urgency, then routes to configured destinations.
        </p>

        <div className="land-stack">
          <span>Node.js</span><span>Python</span><span>BullMQ</span>
          <span>Redis</span><span>Postgres + pgvector</span>
          <span>FastAPI</span><span>Docker</span>
        </div>

        <div className="land-actions">
          <button className="land-btn primary" onClick={() => router.push('/showcase')}>
            Live Demo
          </button>
          <button className="land-btn secondary" onClick={() => router.push('/dashboard')}>
            Admin Dashboard
          </button>
        </div>

        <div className="land-pipeline">
          {['Upload / Message', 'Queue (BullMQ)', 'Parse + Chunk', 'Embed (vectors)', 'Classify (AI)', 'Route → Destination'].map((step, i, arr) => (
            <div key={step} className="land-pipe-row">
              <div className="land-pipe-step">{step}</div>
              {i < arr.length - 1 && <div className="land-pipe-arrow">↓</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

