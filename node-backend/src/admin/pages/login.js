import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

export default function Login() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function login(e) {
    e.preventDefault();
    const res = await fetch('/admin-api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      router.push('/dashboard');
    } else {
      setError('Invalid password');
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-box">
        <h1>AI Platform</h1>
        <form onSubmit={login}>
          <input
            type="password"
            placeholder="Admin password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoFocus
          />
          {error && <p className="error">{error}</p>}
          <button type="submit" className="btn full">Login</button>
        </form>
      </div>
    </div>
  );
}