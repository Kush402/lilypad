import { useEffect, useState } from 'react';

const BACKEND = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8080';

interface HealthReport {
  status: string;
  uptimeSeconds: number;
  checks: { postgres: string; redis: string };
  version: string;
}

/** Cards planned for M6; today they show placeholders + a live backend probe. */
const METRICS = [
  { key: 'users', label: 'Users', hint: 'M6' },
  { key: 'devices', label: 'Devices', hint: 'M6' },
  { key: 'sessions', label: 'Active sessions', hint: 'M6' },
  { key: 'failed', label: 'Failed pairings', hint: 'M6' },
  { key: 'turn', label: 'TURN usage', hint: 'M6' },
  { key: 'billing', label: 'Billing', hint: 'M6' },
];

export function App() {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`${BACKEND}/health`)
      .then((r) => r.json())
      .then(setHealth)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="wrap">
      <header>
        <h1>🪷 Lilypad Admin</h1>
        <span className="tag">scaffold · wired in M6</span>
      </header>

      <section className="health">
        <h2>Backend</h2>
        {health ? (
          <ul>
            <li>
              status <b className={health.status === 'ok' ? 'ok' : 'bad'}>{health.status}</b>
            </li>
            <li>
              postgres{' '}
              <b className={health.checks.postgres === 'up' ? 'ok' : 'bad'}>
                {health.checks.postgres}
              </b>
            </li>
            <li>
              redis{' '}
              <b className={health.checks.redis === 'up' ? 'ok' : 'bad'}>{health.checks.redis}</b>
            </li>
            <li>uptime {health.uptimeSeconds}s</li>
            <li>v{health.version}</li>
          </ul>
        ) : (
          <p className="muted">{error ? `backend unreachable: ${error}` : 'probing…'}</p>
        )}
      </section>

      <section className="grid">
        {METRICS.map((m) => (
          <div key={m.key} className="card">
            <span className="card__label">{m.label}</span>
            <span className="card__value">—</span>
            <span className="card__hint">{m.hint}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
