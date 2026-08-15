import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing ([ADR-0012](../../../../docs/adr/0012-password-authentication.md)).
 *
 * **scrypt, from the standard library.** argon2id is the stronger primitive and
 * the one to move to if this ever becomes the bottleneck, but every Node
 * implementation of it is a native module — a compiled dependency in the deploy
 * path for a difference that changes no attack this product plausibly faces.
 * The encoding below carries its own parameters, so raising the cost, or
 * switching algorithm entirely, is a migration rather than a rewrite: old rows
 * keep verifying with the parameters they were written with.
 */

/** CPU/memory cost. 32768 is the OWASP floor for scrypt at r=8, p=1, and costs
 * roughly 100ms here — high enough to matter offline, low enough that the
 * sign-in route's rate limit is still the binding constraint online. */
const N = 32768;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

/**
 * scrypt needs about `128 * N * r` bytes. Node's default `maxmem` is 32 MiB,
 * which is BELOW what these parameters require — without this the call throws
 * rather than running slowly, so it is a correctness setting, not a tuning one.
 */
const MAX_MEMORY = 128 * N * BLOCK_SIZE * 2;

/** Guard against a stored hash whose parameters would make verification a
 * denial of service. Nothing but this module writes these values, so a row
 * outside these bounds is corruption or tampering, not an old format. */
const MAX_N = 1 << 20;
const MAX_KEY_BYTES = 256;

function derive(
  password: string,
  salt: Buffer,
  cost: number,
  r: number,
  p: number,
  keylen: number,
) {
  return new Promise<Buffer>((resolve, reject) => {
    // NFKC so a password typed with a composed accent verifies against the same
    // password typed with a combining one — NIST SP 800-63B §5.1.1.2. Without
    // it the two are different byte strings and the user is simply locked out.
    scrypt(
      password.normalize('NFKC'),
      salt,
      keylen,
      { N: cost, r, p, maxmem: Math.max(MAX_MEMORY, 128 * cost * r * 2) },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** Hash a password for storage. The result is self-describing: `scheme$N$r$p$salt$hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, BLOCK_SIZE, PARALLELISM, KEY_BYTES);
  return [
    'scrypt',
    N,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/**
 * Check a password against a stored hash.
 *
 * Never throws on a malformed or unknown-scheme stored value — it returns
 * false. A row we cannot parse is a row nobody can sign in with, which is the
 * safe answer; throwing would turn one bad row into a 500 that distinguishes it
 * from every other failure.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [scheme, costRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (scheme !== 'scrypt') return false;

  const cost = Number(costRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(cost) || cost < 2 || cost > MAX_N) return false;
  if (!Number.isInteger(r) || r < 1 || r > 64) return false;
  if (!Number.isInteger(p) || p < 1 || p > 16) return false;

  const salt = Buffer.from(saltRaw, 'base64url');
  const expected = Buffer.from(hashRaw, 'base64url');
  if (salt.length === 0 || expected.length === 0 || expected.length > MAX_KEY_BYTES) return false;

  try {
    const actual = await derive(password, salt, cost, r, p, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * A real hash of a value nobody knows, verified against when the address has no
 * account or has no password set.
 *
 * Without this, "unknown address" returns in microseconds while "wrong
 * password" takes ~100ms, and the difference is a reliable account-existence
 * oracle on the one route an attacker would actually automate. Computed once,
 * lazily, so the cost lands on the first sign-in rather than on every boot.
 */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummy;
}

/** Burn the same wall-clock time a real verification costs, and always fail.
 * Call this on the no-account and no-password branches. */
export async function verifyAgainstDummy(password: string): Promise<false> {
  await verifyPassword(password, await dummyHash());
  return false;
}
