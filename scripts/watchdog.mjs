#!/usr/bin/env node
/**
 * Production watchdog — the thing that notices before a customer does.
 *
 * Lilypad had no monitoring at all: /metrics existed and nothing read it, and
 * the only way to learn the API was down was to try it. This probes what a
 * customer's first minute actually depends on, plus the host facts no HTTP
 * request can see (disk, memory, backup freshness, relay state), and returns a
 * machine-readable verdict the workflow turns into a GitHub issue.
 *
 * Design rules, learned the hard way from noisy monitors:
 *  - Alert on what a user would feel, not on what a graph would show. Disk at
 *    71% is not an incident; disk at 90% is a database that stops writing.
 *  - Every check names its own remedy. An alert nobody can act on trains
 *    people to ignore alerts.
 *  - The probe must not need production secrets it does not use. The SSH key
 *    here is confined by a forced command to one read-only script.
 *
 * Usage: node scripts/watchdog.mjs   → prints a JSON verdict, exit 1 if firing.
 */

const API = process.env.API_BASE ?? 'https://api.takedia.com';
const SITE = process.env.SITE_URL ?? 'https://lilypadhome.takedia.com';
const TURN_HOST = process.env.TURN_HOST ?? '';
const HOSTS = (process.env.STATUS_HOSTS ?? '').split(',').filter(Boolean);

/** Alert thresholds. Deliberately here and not on the hosts: changing what
 * counts as "full" must not require touching production. */
const DISK_PERCENT = 88;
const MEM_PERCENT = 92;
/** Backups run nightly, so 36h means at least one has silently failed. */
const BACKUP_MAX_AGE_S = 36 * 3600;
/** Redis runs with a 128 MB cap and `volatile-ttl`. Crossing this means the
 * next burst starts evicting, and an eviction here is a customer's session
 * failing to reconnect — see the `redisEvictedKeys` alert below. */
const REDIS_PERCENT = 75;
/** certbot renews at 30 days out, so this firing means renewal is already
 * failing rather than merely due. */
const TLS_MIN_DAYS = 14;

const findings = [];
const facts = {};

/** @param {'critical'|'warning'} severity */
function alert(severity, check, detail, remedy) {
  findings.push({ severity, check, detail, remedy });
}

async function timed(fn) {
  const t0 = performance.now();
  try {
    return { value: await fn(), ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { error: String(err?.message ?? err), ms: Math.round(performance.now() - t0) };
  }
}

async function checkApi() {
  const probe = await timed(async () => {
    const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(15_000) });
    return { status: res.status, body: await res.json() };
  });
  facts.api = probe;
  if (probe.error) {
    return alert('critical', 'api', `GET ${API}/health failed: ${probe.error}`,
      'Check the cloudflared tunnel and the backend container on the production VM.');
  }
  const { status, body } = probe.value;
  if (status !== 200 || body.status !== 'ok') {
    // /health reports WHICH dependency is down, so the alert can say so
    // instead of making someone SSH in to find out.
    const down = Object.entries(body.checks ?? {}).filter(([, v]) => v !== 'up').map(([k]) => k);
    return alert('critical', 'api',
      `health is ${body.status ?? status}${down.length ? `; down: ${down.join(', ')}` : ''}`,
      down.length ? `Restart the ${down.join(' and ')} container(s) and check disk.` :
        'Backend is answering but not healthy — read its container logs.');
  }
  // A latency ceiling, not an average: this is one sample over Cloudflare and
  // only means something when it is badly wrong.
  if (probe.ms > 3000) {
    alert('warning', 'api-latency', `/health took ${probe.ms} ms`,
      'Check VM load and Postgres responsiveness.');
  }
}

/**
 * The signals that separate "the process is alive" from "the API is working":
 * error rate, auth-failure rate, rate-limit storms, and tail latency. All are
 * windowed server-side, so this needs no memory between runs.
 */
async function checkMetrics() {
  const token = process.env.METRICS_BEARER_TOKEN;
  if (!token) return; // not configured for this run; not an alert on its own
  const probe = await timed(async () => {
    const res = await fetch(`${API}/metrics`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  facts.metrics = probe;
  if (probe.error) {
    return alert('warning', 'metrics', `GET ${API}/metrics failed: ${probe.error}`,
      'Check METRICS_BEARER_TOKEN matches production, then the backend logs.');
  }
  const m = probe.value;
  // A rate, not a count: five 500s out of five requests is an outage, five out
  // of fifty thousand is a scraper hitting a bad path.
  //
  // ...and a floor under the denominator, because a rate over a tiny sample is
  // not a rate. Observed on the first live scrape: five 503s out of fifteen
  // requests — all of them this audit's own probes of the deliberately
  // unavailable email route — read as a 33% error rate. Below this floor the
  // `api` check above is the one that speaks, and it reads /health rather than
  // guessing from arithmetic.
  const MIN_SAMPLE = 20;
  if (m.requests >= MIN_SAMPLE && m.errors5xx / m.requests > 0.05) {
    alert('critical', 'error-rate',
      `${m.errors5xx} of ${m.requests} requests returned 5xx in the last ${m.windowMinutes} min`,
      'Read the backend logs — something is throwing, not merely refusing.');
  }
  if (m.authFailures >= 100) {
    alert('warning', 'auth-failures',
      `${m.authFailures} 401/403 responses in ${m.windowMinutes} min`,
      'Either a credential-stuffing run, or a client version that has broken its own auth. Check audit_logs for the addresses tried.');
  }
  if (m.rateLimited >= 50) {
    alert('warning', 'rate-limited',
      `${m.rateLimited} requests rate-limited in ${m.windowMinutes} min`,
      'An attack, or a limit set too low for real use. Check whether one IP or many.');
  }
  if (m.latencyP95Ms !== null && m.latencyP95Ms > 2000) {
    alert('warning', 'latency',
      `p95 request latency is ${m.latencyP95Ms} ms over the last ${m.latency ?? 512} samples`,
      'Check Postgres load and VM CPU.');
  }
}

async function checkSite() {
  const probe = await timed(async () => {
    const res = await fetch(SITE, { signal: AbortSignal.timeout(15_000) });
    return { status: res.status, length: (await res.text()).length };
  });
  facts.site = probe;
  if (probe.error || probe.value.status !== 200) {
    alert('critical', 'site',
      `GET ${SITE} → ${probe.error ?? probe.value.status}`,
      'The download page is how customers get the app. Check Cloudflare Pages.');
  }
}

/**
 * The relay, proved by a real STUN Binding request over UDP rather than by a
 * port scan: coturn can be listening and still be refusing to allocate.
 */
async function checkTurn() {
  if (!TURN_HOST) return;
  const dgram = await import('node:dgram');
  const probe = await timed(() => new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const txId = Buffer.from(crypto.getRandomValues(new Uint8Array(12)));
    // RFC 5389 Binding Request: type 0x0001, length 0, magic cookie, tx id.
    const req = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), txId,
    ]);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('no STUN response within 5s'));
    }, 5000);
    socket.on('message', (msg) => {
      clearTimeout(timer);
      socket.close();
      // 0x0101 = Binding Success Response, and the transaction id must match.
      const ok = msg.length >= 20 && msg.readUInt16BE(0) === 0x0101 && msg.subarray(8, 20).equals(txId);
      ok ? resolve('binding-success') : reject(new Error(`unexpected STUN reply 0x${msg.readUInt16BE(0).toString(16)}`));
    });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
    socket.send(req, 3478, TURN_HOST);
  }));
  facts.turn = probe;
  if (probe.error) {
    alert('critical', 'turn',
      `STUN binding to ${TURN_HOST}:3478/udp failed: ${probe.error}`,
      'Sessions that cannot go direct will fail entirely. Check coturn and the OCI NSG.');
  }
}

async function checkHosts() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  facts.hosts = {};
  for (const host of HOSTS) {
    const probe = await timed(async () => {
      const { stdout } = await run('ssh', [
        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
        '-i', process.env.MONITOR_KEY_PATH ?? '/dev/null', host,
      ], { timeout: 30_000 });
      return JSON.parse(stdout);
    });
    facts.hosts[host] = probe;
    if (probe.error) {
      alert('critical', `host:${host}`, `status probe failed: ${probe.error}`,
        'The VM may be down, or Oracle may have reclaimed it. Check the OCI console.');
      continue;
    }
    const s = probe.value;
    if (s.diskPercent >= DISK_PERCENT) {
      alert('critical', `disk:${s.host}`, `root filesystem ${s.diskPercent}% full`,
        'Postgres stops accepting writes on a full disk. Prune docker images and old backups.');
    }
    if (s.memPercent >= MEM_PERCENT) {
      alert('warning', `memory:${s.host}`, `memory ${s.memPercent}% used`,
        'These are 1 GB Always-Free VMs; the OOM killer takes Postgres first.');
    }
    for (const c of s.containers ?? []) {
      if (c.state !== 'running') {
        alert('critical', `container:${c.name}`, `state is ${c.state}`,
          'Bring the compose stack back up and read the container logs for why it exited.');
      } else if (c.healthy === false) {
        alert('critical', `container:${c.name}`, 'healthcheck failing',
          'The container is running but not serving. Check its logs.');
      }
    }
    if (s.backupAgeSeconds === -1) {
      alert('critical', `backup:${s.host}`, 'backup directory exists but is empty',
        'Backups used to run here. Check the cron entry and backup.sh.');
    } else if (s.backupAgeSeconds > BACKUP_MAX_AGE_S) {
      alert('critical', `backup:${s.host}`,
        `newest backup is ${Math.round(s.backupAgeSeconds / 3600)}h old`,
        'At least one nightly backup has failed silently. Run backup.sh by hand and read the error.');
    }
    // Reported and alerted separately from the local dump: the two fail
    // independently, and a local backup on the same disk as its database is
    // no help at all in the scenario the backup exists for.
    if (s.offsiteBackupAgeSeconds === -1) {
      alert('critical', `offsite-backup:${s.host}`, 'the off-host backup directory exists but is empty',
        'Copies used to arrive here. Check backup.sh on the production VM and the offsite key.');
    } else if (s.offsiteBackupAgeSeconds > BACKUP_MAX_AGE_S) {
      alert('critical', `offsite-backup:${s.host}`,
        `newest off-host copy is ${Math.round(s.offsiteBackupAgeSeconds / 3600)}h old`,
        'The database is currently protected only by a copy on the same disk as itself. Run backup.sh by hand and read the error.');
    }
    if (s.coturn === 'failed' || s.coturn === 'inactive') {
      alert('critical', `coturn:${s.host}`, `coturn is ${s.coturn}`,
        'systemctl status coturn on the relay VM.');
    }
    if (s.rebootRequired) {
      alert('warning', `patches:${s.host}`, 'a reboot is pending for applied security updates',
        'The host is running the old kernel/libc. Schedule a reboot.');
    }
    // Redis went from "unlimited, and one day the OOM killer takes Postgres" to
    // "capped, and one day it evicts". That is the better failure and the
    // quieter one, so it needs an alarm bolted to it or the fix just moves the
    // outage somewhere harder to see.
    if (typeof s.redisEvictedKeys === 'number' && s.redisEvictedKeys > 0) {
      alert('critical', `redis-evictions:${s.host}`,
        `Redis has evicted ${s.redisEvictedKeys} keys`,
        'Redis is at its 128 MB cap. Evicted keys are pairing tokens and live room-authorization records, so somebody is being told to pair again mid-session. Check for a flood of /devices/challenge or /pairing/create, then raise --maxmemory in infra/production/docker-compose.yml.');
    }
    if (typeof s.redisUsedBytes === 'number' && s.redisMaxBytes > 0) {
      const pct = Math.round((s.redisUsedBytes / s.redisMaxBytes) * 100);
      if (pct >= REDIS_PERCENT) {
        alert('warning', `redis-memory:${s.host}`, `Redis is at ${pct}% of its cap`,
          'Steady state is well under 2 MB, so this is either real growth or a flood. Check /metrics for the request rate before raising the cap.');
      }
    }
    if (s.redisMaxBytes === 0) {
      alert('warning', `redis-unbounded:${s.host}`, 'Redis is running with no maxmemory',
        'An unbounded Redis on a 952 MB VM ends as an OOM kill of whatever has the largest RSS, which is Postgres. The compose file sets --maxmemory 128mb; this host is not running it.');
    }
  }
}

/**
 * The relay's TLS certificate.
 *
 * coturn serves TURNS on 443 from a Let's Encrypt certificate, renewed by a
 * certbot timer with a deploy hook that restarts the service. All of that is
 * wired correctly today — which is exactly why nobody would notice the day it
 * stops. A relay certificate expiring does not degrade anything gently: TURNS
 * on 443 is the path for users behind networks that allow nothing but HTTPS,
 * so for them it is the difference between a session and no session.
 *
 * Fourteen days is the alert horizon because certbot renews at thirty. Seeing
 * this fire means two renewal windows have already been missed.
 */
async function checkTurnTls() {
  if (!TURN_HOST) return;
  const tls = await import('node:tls');
  const probe = await timed(() => new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: TURN_HOST, port: 443, servername: 'turn.takedia.com', timeout: 8000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) return reject(new Error('no certificate presented'));
        resolve({ validTo: cert.valid_to, subject: cert.subject?.CN ?? null });
      },
    );
    socket.on('timeout', () => { socket.destroy(); reject(new Error('TLS handshake timed out')); });
    socket.on('error', reject);
  }));
  facts.turnTls = probe;
  if (probe.error) {
    return alert('critical', 'turn-tls',
      `TLS handshake with ${TURN_HOST}:443 failed: ${probe.error}`,
      'TURNS on 443 is the only path for users on networks that allow nothing but HTTPS. Check coturn and /etc/coturn/certs.');
  }
  const daysLeft = Math.floor((Date.parse(probe.value.validTo) - Date.now()) / 86_400_000);
  facts.turnTls.daysLeft = daysLeft;
  if (daysLeft <= TLS_MIN_DAYS) {
    alert(daysLeft <= 3 ? 'critical' : 'warning', 'turn-tls-expiry',
      `the relay certificate expires in ${daysLeft} days`,
      'certbot renews at 30 days, so this means renewal has been failing. Run `certbot renew --dry-run` on the relay VM and check /etc/letsencrypt/renewal-hooks/deploy/coturn.sh still runs.');
  }
}

await checkApi();
await checkMetrics();
await checkSite();
await checkTurn();
await checkTurnTls();
await checkHosts();

const critical = findings.filter((f) => f.severity === 'critical');
const verdict = {
  at: new Date().toISOString(),
  firing: findings.length > 0,
  critical: critical.length,
  warnings: findings.length - critical.length,
  findings,
  facts,
};
console.log(JSON.stringify(verdict, null, 2));
// Exit 1 for ANY finding: the workflow decides how loudly to react, and a
// warning that never surfaces is the same as no monitoring.
process.exit(findings.length > 0 ? 1 : 0);
