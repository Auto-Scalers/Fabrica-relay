import { describe, it, expect } from "vitest";
import { verifyHmacSha256, timingSafeEqual, nacl } from "../shared/crypto";

describe("verifyHmacSha256", () => {
  it("returns true for valid HMAC", async () => {
    const key = new TextEncoder().encode("secret-key");
    const data = new TextEncoder().encode("hello world");
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expectedSig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
    const result = await verifyHmacSha256(key, data, expectedSig);
    expect(result).toBe(true);
  });

  it("returns false for invalid HMAC", async () => {
    const key = new TextEncoder().encode("secret-key");
    const data = new TextEncoder().encode("hello world");
    const badSig = new Uint8Array(32).fill(0xff);
    const result = await verifyHmacSha256(key, data, badSig);
    expect(result).toBe(false);
  });
});

describe("timingSafeEqual", () => {
  it("returns true for equal arrays", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    expect(timingSafeEqual(a, b)).toBe(true);
  });

  it("returns false for unequal arrays", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 4]);
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  it("returns false for different lengths", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2]);
    expect(timingSafeEqual(a, b)).toBe(false);
  });
});

describe("nacl.box", () => {
  it("encrypts and decrypts roundtrip", () => {
    const senderKp = nacl.box.keyPair();
    const recipientKp = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const message = new TextEncoder().encode("test message");

    const ciphertext = nacl.box(message, nonce, recipientKp.publicKey, senderKp.secretKey);
    expect(ciphertext).toBeInstanceOf(Uint8Array);

    const decrypted = nacl.box.open(ciphertext, nonce, senderKp.publicKey, recipientKp.secretKey);
    expect(decrypted).not.toBeNull();
    expect(new TextDecoder().decode(decrypted!)).toBe("test message");
  });
});
