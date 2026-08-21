// Shared crypto — tweetnacl (NaCl box) + Web Crypto HMAC-SHA256 (Workers-safe)

import nacl from "tweetnacl";

export { nacl };

// Workers has no node:crypto; use Web Crypto crypto.subtle for HMAC-SHA256
export async function hmacSha256(key: BufferSource, data: BufferSource): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, data);
}

export async function hmacSha256Bytes(key: BufferSource, data: BufferSource): Promise<Uint8Array> {
  return new Uint8Array(await hmacSha256(key, data));
}

// Constant-time byte comparison (Workers has no timingSafeEqual)
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

// Constant-time HMAC verification
export async function verifyHmacSha256(
  key: BufferSource,
  data: BufferSource,
  expected: Uint8Array,
): Promise<boolean> {
  const actual = await hmacSha256Bytes(key, data);
  return timingSafeEqual(actual, expected);
}