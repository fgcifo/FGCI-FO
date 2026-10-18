// lib/auth.js — utenti e token di sessione (condivisi da api/rapporti.js e api/chain.js).
const crypto = require("crypto");

const DURATA_SESSIONE_MS = 12 * 60 * 60 * 1000;
const secret = () => process.env.SESSION_SECRET || "";

function utenti() {
  const m = {};
  if (process.env.ADMIN_USERS) {
    try { Object.assign(m, JSON.parse(process.env.ADMIN_USERS)); } catch (e) { /* JSON non valido: ignorato */ }
  }
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) m[process.env.ADMIN_USERNAME] = process.env.ADMIN_PASSWORD;
  return m;
}

const hash = v => crypto.createHash("sha256").update(String(v)).digest();
const uguali = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));
const firma = payload => crypto.createHmac("sha256", secret()).update(payload).digest("base64url");

function creaToken(utente) {
  const p = Buffer.from(JSON.stringify({ u: utente, exp: Date.now() + DURATA_SESSIONE_MS })).toString("base64url");
  return p + "." + firma(p);
}

// Restituisce il nome utente se il token è valido e non scaduto, altrimenti null.
function verificaToken(req) {
  const m = (req.headers.authorization || "").match(/^Bearer (.+)$/);
  if (!m || !secret()) return null;
  const [p, s] = m[1].split(".");
  if (!p || !s) return null;
  const atteso = firma(p);
  if (s.length !== atteso.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(atteso))) return null;
  try {
    const d = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    return d.exp > Date.now() ? d.u : null;
  } catch (e) { return null; }
}

module.exports = { utenti, uguali, creaToken, verificaToken, haSecret: () => !!secret() };
