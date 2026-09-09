/**
 * Encryption for owner-supplied secrets (bring-your-own gateway keys).
 *
 * AES-256-GCM through Web Crypto, which the Convex default runtime provides. The
 * wrapping key is the deployment's `BYOK_ENCRYPTION_KEY` (32 random bytes,
 * base64), set with `npx convex env set`. Ciphertext and IV are stored; the
 * plaintext exists only inside the action that uses the key. Nothing here is a
 * substitute for a KMS — it keeps a database dump from being a key dump.
 */

const ALGORITHM = "AES-GCM";
const IV_BYTES = 12;

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** True when the deployment can store secrets at all. */
export function secretsConfigured(): boolean {
  return typeof process.env.BYOK_ENCRYPTION_KEY === "string" && process.env.BYOK_ENCRYPTION_KEY.length > 0;
}

async function wrappingKey(): Promise<CryptoKey> {
  const raw = process.env.BYOK_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "BYOK_ENCRYPTION_KEY is not set on this deployment; owner gateway keys cannot be stored.",
    );
  }
  const bytes = fromBase64(raw);
  if (bytes.length !== 32) {
    throw new Error("BYOK_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
  }
  return crypto.subtle.importKey("raw", bytes.buffer as ArrayBuffer, ALGORITHM, false, ["encrypt", "decrypt"]);
}

export type SealedSecret = { ciphertext: string; iv: string };

export async function encryptSecret(plaintext: string): Promise<SealedSecret> {
  const key = await wrappingKey();
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)));
  const encoded = new TextEncoder().encode(plaintext);
  const sealed = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer,
  );
  return { ciphertext: toBase64(new Uint8Array(sealed)), iv: toBase64(iv) };
}

export async function decryptSecret(sealed: SealedSecret): Promise<string> {
  const key = await wrappingKey();
  const iv = fromBase64(sealed.iv);
  const opened = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: iv.buffer.slice(0, iv.byteLength) as ArrayBuffer },
    key,
    fromBase64(sealed.ciphertext).buffer as ArrayBuffer,
  );
  return new TextDecoder().decode(opened);
}

/** The visible tail of a key: enough to recognise it, never enough to use it. */
export function keyTail(secret: string): string {
  return secret.slice(-4);
}
