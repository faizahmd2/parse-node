import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';

const API = '/admin-api';

export default function Dashboard() {
  const router = useRouter();
  const [view, setView] = useState('clients');          // clients | detail
  const [clients, setClients] = useState([]);
  const [selected, setSelected] = useState(null);       // selected client
  const [categories, setCategories] = useState([]);
  const [destinations, setDestinations] = useState([]);
  const [rules, setRules] = useState([]);
  const [activity, setActivity] = useState([]);
  const [gmailLink, setGmailLink] = useState('');
  const [tab, setTab] = useState('categories');          // categories | destinations | rules | activity
  const [form, setForm] = useState({});
  const [msg, setMsg] = useState('');

  useEffect(() => { loadClients(); }, []);

  async function api(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { router.push('/login'); return null; }
    return res.json();
  }

  async function loadClients() {
    const data = await api('GET', '/clients');
    if (data) setClients(data);
  }

  async function selectClient(client) {
    setSelected(client);
    setView('detail');
    setTab('categories');
    setGmailLink('');
    const [cats, dests, rls, act] = await Promise.all([
      api('GET', `/clients/${client.id}/categories`),
      api('GET', `/clients/${client.id}/destinations`),
      api('GET', `/clients/${client.id}/rules`),
      api('GET', `/clients/${client.id}/activity`),
    ]);
    setCategories(cats || []);
    setDestinations(dests || []);
    setRules(rls || []);
    setActivity(act || []);
  }

  async function addClient() {
    const name = prompt('Client name:');
    if (!name) return;
    const data = await api('POST', '/clients', { name });
    if (data) { setMsg(`Created. API Key: ${data.api_key}`); loadClients(); }
  }

  async function deleteClient(id) {
    if (!confirm('Delete client and all their data?')) return;
    await api('DELETE', `/clients/${id}`);
    loadClients();
    setView('clients');
  }

  async function toggleClient(client) {
    await api('PATCH', `/clients/${client.id}`, { active: !client.active });
    loadClients();
  }

  async function addCategory() {
    const data = await api('POST', `/clients/${selected.id}/categories`, {
      type: form.catType || 'category',
      value: form.catValue,
      description: form.catDesc,
    });
    if (data) { setForm({}); setCategories([...categories, data]); }
  }

  async function deleteCategory(id) {
    await api('DELETE', `/categories/${id}`);
    setCategories(categories.filter(c => c.id !== id));
  }

  async function addDestination() {
    let config;
    try { config = JSON.parse(form.destConfig); }
    catch { setMsg('Config must be valid JSON'); return; }
    const data = await api('POST', `/clients/${selected.id}/destinations`, {
      name: form.destName,
      type: form.destType,
      config,
    });
    if (data) { setForm({}); setDestinations([...destinations, data]); }
  }

  async function deleteDestination(id) {
    await api('DELETE', `/destinations/${id}`);
    setDestinations(destinations.filter(d => d.id !== id));
  }

  async function addRule() {
    let condition;
    try { condition = JSON.parse(form.ruleCondition); }
    catch { setMsg('Condition must be valid JSON'); return; }
    const data = await api('POST', `/clients/${selected.id}/rules`, {
      priority: parseInt(form.rulePriority) || 1,
      condition,
      destination_id: form.ruleDestId,
    });
    if (data) { setForm({}); setRules([...rules, data]); }
  }

  async function deleteRule(id) {
    await api('DELETE', `/rules/${id}`);
    setRules(rules.filter(r => r.id !== id));
  }

  async function getGmailLink() {
    const data = await api('GET', `/clients/${selected.id}/gmail-link`);
    if (data) setGmailLink(data.link);
  }

  async function logout() {
    await api('POST', '/logout');
    router.push('/');
  }

  // --- RENDER ---
  return (
    <div className="app">
      <div className="dash-nav">
        <span className="dash-nav-logo">AI Ingestion Platform — Admin</span>
        <button className="btn-ghost" onClick={() => router.push('/showcase')}>← Live Demo</button>
        <button className="btn-ghost" onClick={logout}>Logout</button>
      </div>

      {msg && <div className="banner" onClick={() => setMsg('')}>{msg} ✕</div>}

      {view === 'clients' && (
        <div className="panel">
          <div className="panel-header">
            <h2>Clients</h2>
            <button onClick={addClient} className="btn">+ Add Client</button>
          </div>
          {clients.length === 0 && <p className="empty">No clients yet.</p>}
          {clients.map(c => (
            <div key={c.id} className="row" onClick={() => selectClient(c)}>
              <div>
                <strong>{c.name}</strong>
                <span className="meta">{c.gmail_email || 'No Gmail connected'}</span>
              </div>
              <div className="row-actions" onClick={e => e.stopPropagation()}>
                <span className={`badge ${c.active ? 'green' : 'grey'}`}>
                  {c.active ? 'Active' : 'Inactive'}
                </span>
                <button onClick={() => toggleClient(c)} className="btn-sm">
                  {c.active ? 'Disable' : 'Enable'}
                </button>
                <button onClick={() => deleteClient(c.id)} className="btn-sm danger">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {view === 'detail' && selected && (
        <div className="panel">
          <div className="panel-header">
            <button onClick={() => setView('clients')} className="btn-ghost">← Back</button>
            <h2>{selected.name}</h2>
            <code className="api-key">{selected.api_key}</code>
          </div>

          <div className="gmail-section">
            {selected.gmail_email
              ? <span className="badge green">Gmail: {selected.gmail_email}</span>
              : <button onClick={getGmailLink} className="btn">Generate Gmail OAuth Link</button>
            }
            {gmailLink && (
              <div className="link-box">
                <span>Send this link to client:</span>
                <a href={gmailLink} target="_blank">{gmailLink}</a>
                <button onClick={() => { navigator.clipboard.writeText(gmailLink); setMsg('Copied!'); }}
                  className="btn-sm">Copy</button>
              </div>
            )}
          </div>

          <div className="tabs">
            {['categories', 'destinations', 'rules', 'activity'].map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`tab ${tab === t ? 'active' : ''}`}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {tab === 'categories' && (
            <div>
              <div className="add-form">
                <select onChange={e => setForm({ ...form, catType: e.target.value })} defaultValue="category">
                  <option value="category">Category</option>
                  <option value="urgency">Urgency</option>
                </select>
                <input placeholder="Value (e.g. billing issue)"
                  onChange={e => setForm({ ...form, catValue: e.target.value })} />
                <input placeholder="Description (helps AI)"
                  onChange={e => setForm({ ...form, catDesc: e.target.value })} />
                <button onClick={addCategory} className="btn">Add</button>
              </div>
              {categories.map(c => (
                <div key={c.id} className="row">
                  <div>
                    <span className="badge grey">{c.type}</span>
                    <strong>{c.value}</strong>
                    <span className="meta">{c.description}</span>
                  </div>
                  <button onClick={() => deleteCategory(c.id)} className="btn-sm danger">Remove</button>
                </div>
              ))}
            </div>
          )}

          {tab === 'destinations' && (
            <div>
              <div className="add-form">
                <input placeholder="Name (e.g. billing-webhook)"
                  onChange={e => setForm({ ...form, destName: e.target.value })} />
                <select onChange={e => setForm({ ...form, destType: e.target.value })} defaultValue="webhook">
                  <option value="webhook">Webhook</option>
                  <option value="telegram">Telegram</option>
                  <option value="slack">Slack</option>
                </select>
                <input placeholder='Config JSON e.g. {"url":"https://..."}'
                  onChange={e => setForm({ ...form, destConfig: e.target.value })} />
                <button onClick={addDestination} className="btn">Add</button>
              </div>
              {destinations.map(d => (
                <div key={d.id} className="row">
                  <div>
                    <span className="badge grey">{d.type}</span>
                    <strong>{d.name}</strong>
                  </div>
                  <button onClick={() => deleteDestination(d.id)} className="btn-sm danger">Remove</button>
                </div>
              ))}
            </div>
          )}

          {tab === 'rules' && (
            <div>
              <div className="add-form">
                <input placeholder="Priority (1 = highest)"
                  onChange={e => setForm({ ...form, rulePriority: e.target.value })} />
                <input placeholder='Condition JSON e.g. {"category":"billing","urgency":"high"}'
                  onChange={e => setForm({ ...form, ruleCondition: e.target.value })} />
                <select onChange={e => setForm({ ...form, ruleDestId: e.target.value })}>
                  <option value="">Select destination</option>
                  {destinations.map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
                <button onClick={addRule} className="btn">Add</button>
              </div>
              {rules.map(r => (
                <div key={r.id} className="row">
                  <div>
                    <span className="badge grey">P{r.priority}</span>
                    <code>{JSON.stringify(r.condition)}</code>
                    <span className="meta">→ {r.destination_name}</span>
                  </div>
                  <button onClick={() => deleteRule(r.id)} className="btn-sm danger">Remove</button>
                </div>
              ))}
            </div>
          )}

          {tab === 'activity' && (
            <div>
              {activity.length === 0 && <p className="empty">No successful routes or errors yet.</p>}
              {activity.map(a => (
                <div key={a.id} className="row">
                  <div>
                    <span className={`badge ${a.routing_status === 'sent' ? 'green' : 'red'}`}>
                      {a.routing_status}
                    </span>
                    <span className="badge grey">{a.channel}</span>
                    <strong>{a.subject || a.from_identifier}</strong>
                    <span className="meta">
                      {a.classification?.category} · {a.classification?.urgency}
                    </span>
                  </div>
                  <span className="meta">{new Date(a.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}