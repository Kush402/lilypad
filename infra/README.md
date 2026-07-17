# infra

Local development infrastructure for Lilypad.

```bash
# from repo root, after copying .env.example -> .env
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps
```

| Service  | Purpose                                             | Port(s)           | Used from |
| -------- | --------------------------------------------------- | ----------------- | --------- |
| postgres | Users, devices, sessions, audit logs                | 5432              | M1        |
| redis    | Single-use 60s pairing tokens, signaling rooms      | 6379              | M1        |
| coturn   | STUN + TURN for internet-first WebRTC NAT traversal | 3478, 49160–49200 | M2        |

## Notes

- **Milestone 1** only needs Postgres + Redis. coturn is defined now so the
  internet-first transport is ready the moment signaling lands in M2.
- **coturn on Docker Desktop (macOS/Windows):** published ports are used for
  portability. Relay traffic across the Docker NAT works for same-host testing;
  for a real over-the-internet TURN relay, deploy coturn on a public host with
  `network_mode: host`, a real `external-ip`, and a wide relay range.
- **Secrets:** `turnserver.conf` uses a static dev secret. Production must use
  rotated, time-limited TURN credentials (see [../docs/threat-model.md](../docs/threat-model.md)).
