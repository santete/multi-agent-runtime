import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encrypts project secrets at rest (spec §48) with AES-256-GCM. The key comes
 * from MAR_SECRETS_KEY (any string; its SHA-256 is the key) and never touches
 * the database.
 */
export class SecretCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < 16) throw new Error("MAR_SECRETS_KEY must be at least 16 characters");
    this.key = createHash("sha256").update(secret).digest();
  }

  encrypt(plain: string): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag() };
  }

  decrypt(ciphertext: Uint8Array, iv: Uint8Array, authTag: Uint8Array): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}
