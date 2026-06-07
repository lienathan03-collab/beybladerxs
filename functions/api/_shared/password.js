// Server-side password hashing (PBKDF2) with transparent migration from the
// legacy bare-SHA-256 scheme.
//
// The client still sends sha256(password) as `passwordHash`/`*PasswordHash`
// (unchanged). The server now stretches that with PBKDF2 + a per-user random
// salt before storing, so a leak of the `accounts` KV blob no longer yields
// directly-usable or trivially-crackable credentials.
//
// Stored formats:
//   • legacy:  a 64-char hex string (the old sha256)            ← still verified
//   • current: "pbkdf2$<iterations>$<saltB64>$<hashB64>"
//
// Migration is transparent: a legacy account is re-hashed to the pbkdf2 format
// on its next successful login (see player-login.js) and on any password change.
// Until then it keeps working via the legacy branch — nobody is locked out.

const ITERATIONS = 100000;
const enc = new TextEncoder();

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function unb64(str) {
  const bin = atob(str);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

async function derive(clientHash, saltBytes, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(clientHash)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return new Uint8Array(bits);
}

// Constant-time string compare (avoids leaking match position via timing).
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith('pbkdf2$');
}

// True when a stored value is still in the legacy (unstretched) format and
// should be upgraded after a successful verify.
export function needsUpgrade(stored) {
  return typeof stored === 'string' && stored.length > 0 && !isHashed(stored);
}

// Hash a client-supplied sha256 hash into the storable pbkdf2 format.
export async function hashPassword(clientHash) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const dk = await derive(clientHash, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(dk)}`;
}

// Verify a client-supplied sha256 hash against the stored value (either format).
export async function verifyPassword(stored, clientHash) {
  if (stored == null || clientHash == null) return false;
  if (!isHashed(stored)) {
    // Legacy: stored IS the bare sha256 hex.
    return timingSafeEqual(stored, clientHash);
  }
  const parts = String(stored).split('$'); // ['pbkdf2', iter, salt, hash]
  if (parts.length !== 4) return false;
  const iterations = parseInt(parts[1], 10) || ITERATIONS;
  let salt;
  try { salt = unb64(parts[2]); } catch (_) { return false; }
  const dk = await derive(clientHash, salt, iterations);
  return timingSafeEqual(b64(dk), parts[3]);
}
