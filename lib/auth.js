// Eenvoudige, gedeelde-wachtwoord-authenticatie voor /backend en alle
// /api/admin/*-routes — bewust GEEN volwaardig per-medewerker
// account-systeem (dat zou de staff_users-tabel in schema.sql gebruiken,
// met gehashte wachtwoorden per persoon). Voor deze schaal (klein team, één
// gedeelde toegang per rol) is dit de pragmatische aanpak: één wachtwoord
// voor de "admin"-rol, één voor de "gast"-rol (ziet privé-items enkel als
// "Bezet"/"Privé" — zie redactForGuest() in pages/api/admin/sessions.js).
//
// De sessie zelf is een ondertekende cookie (HMAC-SHA256 met AUTH_SECRET),
// niet zomaar een leesbaar "role=admin"-cookie — anders zou iedereen die
// het cookie kan lezen zichzelf tot admin kunnen "promoveren" door de
// waarde met de hand aan te passen.

const crypto = require("crypto");

const SESSION_COOKIE = "aar_staff_session";
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 dagen

function getSecret() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_SECRET ontbreekt in de omgevingsvariabelen — zie .env.example (nodig om sessies te ondertekenen)."
    );
  }
  return secret;
}

function hmac(value) {
  return crypto.createHmac("sha256", getSecret()).update(value).digest("hex");
}

// Timing-safe vergelijking — voorkomt dat een aanvaller via het minutieuze
// tijdsverschil tussen antwoorden een wachtwoord/handtekening karakter per
// karakter zou kunnen raden. Bij een lengteverschil wordt er toch een
// (zinloze) vergelijking van gelijke lengte gedaan, puur om de responstijd
// niet meteen te laten verraden dat de lengte al fout was.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function createSessionToken(role) {
  const expires = Date.now() + SESSION_MAX_AGE_SEC * 1000;
  const payload = `${role}.${expires}`;
  return `${payload}.${hmac(payload)}`;
}

function verifySessionToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [role, expiresStr, sig] = parts;
  if (role !== "admin" && role !== "guest") return null;
  const expected = hmac(`${role}.${expiresStr}`);
  if (!safeEqual(sig, expected)) return null;
  const expires = Number(expiresStr);
  if (!expires || Date.now() > expires) return null;
  return { role };
}

// Vergelijkt met beide geconfigureerde wachtwoorden (admin/gast) en geeft
// de bijhorende rol terug, of null als geen van beide klopt. Een
// niet-geconfigureerd wachtwoord (env var ontbreekt) matcht nooit — dus een
// leeg STAFF_GUEST_PASSWORD betekent "geen gast-toegang", niet "iedereen
// mag binnen als gast".
function verifyPassword(password) {
  if (!password) return null;
  const adminPw = process.env.STAFF_ADMIN_PASSWORD;
  const guestPw = process.env.STAFF_GUEST_PASSWORD;
  if (adminPw && safeEqual(password, adminPw)) return "admin";
  if (guestPw && safeEqual(password, guestPw)) return "guest";
  return null;
}

function parseCookies(cookieHeader) {
  const out = {};
  (cookieHeader || "").split(";").forEach(pair => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

/**
 * Te gebruiken als allereerste regel in elke /api/admin/*-handler. Stuurt
 * zelf een 401 en geeft `null` terug als er geen geldige sessie is — de
 * aanroeper moet dan gewoon meteen `return` doen.
 */
function requireStaff(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const session = verifySessionToken(cookies[SESSION_COOKIE]);
  if (!session) {
    res.status(401).json({ error: "Niet ingelogd." });
    return null;
  }
  return session;
}

module.exports = {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  createSessionToken,
  verifySessionToken,
  verifyPassword,
  requireStaff,
  parseCookies
};
