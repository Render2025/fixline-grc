import { randomToken, sha256Hex } from './crypto';

export async function mintAccessToken(): Promise<{ token: string; hash: string }> {
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  return { token, hash };
}

export async function verifyAccessToken(token: string, hash: string): Promise<boolean> {
  if (!token || !hash) return false;
  const provided = await sha256Hex(token);
  return timingSafeEqual(provided, hash);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
