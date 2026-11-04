import crypto from "crypto";

export const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(String(pw), salt, 32).toString("hex")}`;
};

export const checkPassword = (pw, stored) => {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const a = Buffer.from(hash, "hex");
  const b = crypto.scryptSync(String(pw), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Stateless signed token: base64url(payload).hmac — survives server restarts as long as the secret is kept.
const b64 = (s) => Buffer.from(s).toString("base64url");
const sign = (secret, body) => crypto.createHmac("sha256", secret).update(body).digest("base64url");

export const makeToken = (secret, userId, days = 7) => {
  const body = b64(JSON.stringify({ u: userId, exp: Date.now() + days * 86400000 }));
  return `${body}.${sign(secret, body)}`;
};

export const readToken = (secret, token) => {
  try {
    const [body, sig] = String(token).split(".");
    const good = sign(secret, body);
    if (!sig || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() ? p.u : null;
  } catch { return null; }
};

export const newSecret = () => crypto.randomBytes(32).toString("hex");
