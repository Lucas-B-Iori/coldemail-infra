import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { config } from "../config.ts";

const PREFIX = "enc:v1:";
let key: Buffer | null = null;

function getKey(): Buffer {
  if (
    !config.encryptionKey ||
    /^(troque-por|sua_chave|seu_|your_)/i.test(config.encryptionKey)
  ) {
    throw new Error(
      "Defina ENCRYPTION_KEY no arquivo .env antes de cadastrar contas.",
    );
  }
  return (key ??= scryptSync(config.encryptionKey, "coldmail-engine", 32));
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", getKey(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return (
    PREFIX +
    [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(":")
  );
}

export function decrypt(stored: string): string {
  if (!stored.startsWith(PREFIX))
    throw new Error(
      "Credencial não criptografada: recadastre com ENCRYPTION_KEY estável.",
    );
  try {
    const parts = stored.slice(PREFIX.length).split(":");
    if (
      parts.length !== 3 ||
      parts.some((p) => !/^[A-Za-z0-9+/]*={0,2}$/.test(p))
    )
      throw new Error("invalid ciphertext");
    const [iv, tag, data] = parts.map((p) => Buffer.from(p, "base64"));
    if (iv.length !== 12 || tag.length !== 16)
      throw new Error("invalid ciphertext");
    const d = createDecipheriv("aes-256-gcm", getKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  } catch {
    throw new Error(
      "Falha ao descriptografar credencial: ENCRYPTION_KEY incompatível ou registro corrompido. Preserve banco e chave; recupere a chave original ou recadastre a credencial.",
    );
  }
}
