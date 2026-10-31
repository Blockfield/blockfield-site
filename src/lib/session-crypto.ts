import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** 32 raw bytes from BLOCKFIELD_SESSION_SECRET (64 hex chars). Throws when unset/malformed. */
export function sessionKeyBytes(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.BLOCKFIELD_SESSION_SECRET ?? ''
  if (!/^[0-9a-f]{64}$/i.test(raw))
    throw new Error(
      'BLOCKFIELD_SESSION_SECRET must be 64 hex characters (32 bytes, e.g. `openssl rand -hex 32`).',
    )
  return Buffer.from(raw, 'hex')
}

/** AES-256-GCM seal: fresh IV per token, `ivHex.cipherHex` with the 16-byte tag appended. */
export function sealTokenRaw(token: string, key: Buffer): string {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv)
  const sealed = Buffer.concat([cipher.update(token, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return `${iv.toString('hex')}.${sealed.toString('hex')}`
}

/** Returns null on a wrong key, corruption, or a forged row — never throws. */
export function openTokenRaw(sealed: string, key: Buffer): string | null {
  try {
    const [ivHex, dataHex] = sealed.split('.'),
      iv = Buffer.from(ivHex, 'hex'),
      data = Buffer.from(dataHex, 'hex')
    if (iv.length !== 12 || data.length < 17) return null
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(data.subarray(-16))
    return Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString(
      'utf8',
    )
  } catch {
    return null
  }
}
