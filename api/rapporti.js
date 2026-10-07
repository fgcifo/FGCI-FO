// api/rapporti.js — funzione serverless Vercel (endpoint /api/rapporti).
//
//   GET   (senza token)     -> { testi: [...] } solo i documenti "Pubblicato"
//   GET   (Bearer token)    -> { testi: [...] } tutti, bozze comprese
//   POST  { azione:"login", username, password }  -> { success:true, token }
//   POST  { azione:"salva", testi:[...] }  (Bearer token) -> scrive rapporti.json nella repo DATA
//
// La repo DATA può essere pubblica o privata: il browser non la legge mai direttamente,
// passa sempre da questa funzione, che usa GITHUB_TOKEN (variabile d'ambiente, mai nel codice).
const crypto = require("crypto");

const REPO = process.env.GITHUB_REPO || "fgcifo/DATA";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const FILE = process.env.GITHUB_FILE || "rapporti.json";
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const SECRET = process.env.SESSION_SECRET || "";
const DURATA_SESSIONE_MS = 12 * 60 * 60 * 1000;
const MAX_DOCUMENTI = 500;

/* ---------- utenti e sessione ---------- */

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
const firma = payload => crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");

function creaToken(utente) {
  const p = Buffer.from(JSON.stringify({ u: utente, exp: Date.now() + DURATA_SESSIONE_MS })).toString("base64url");
  return p + "." + firma(p);
}

// Restituisce il nome utente se il token è valido e non scaduto, altrimenti null.
function verificaToken(req) {
  const m = (req.headers.authorization || "").match(/^Bearer (.+)$/);
  if (!m || !SECRET) return null;
  const [p, s] = m[1].split(".");
  if (!p || !s) return null;
  const atteso = firma(p);
  if (s.length !== atteso.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(atteso))) return null;
  try {
    const d = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    return d.exp > Date.now() ? d.u : null;
  } catch (e) { return null; }
}

/* ---------- GitHub ---------- */

const intestazioniGh = () => {
  const h = { Accept: "application/vnd.github+json", "User-Agent": "fgci-rapporti", "X-GitHub-Api-Version": "2022-11-28" };
  if (GH_TOKEN) h.Authorization = "Bearer " + GH_TOKEN;
  return h;
};
const urlFile = () => `https://api.github.com/repos/${REPO}/contents/${FILE.split("/").map(encodeURIComponent).join("/")}`;

async function leggiArchivio() {
  const r = await fetch(`${urlFile()}?ref=${encodeURIComponent(BRANCH)}`, { headers: intestazioniGh(), cache: "no-store" });
  if (r.status === 404) return { testi: [], sha: null };       // il file non esiste ancora: si crea al primo salvataggio
  if (!r.ok) throw new Error(`GitHub ha risposto ${r.status} in lettura (controlla GITHUB_REPO, GITHUB_BRANCH e GITHUB_TOKEN)`);
  const j = await r.json();
  let contenuto = j.content;
  if (!contenuto && j.git_url) {                                  // file oltre 1 MB: si passa dal blob
    const b = await fetch(j.git_url, { headers: intestazioniGh(), cache: "no-store" });
    if (!b.ok) throw new Error(`GitHub ha risposto ${b.status} leggendo il file`);
    contenuto = (await b.json()).content;
  }
  const testo = Buffer.from(contenuto || "", "base64").toString("utf8").trim();
  let dati = [];
  if (testo) {
    try { dati = JSON.parse(testo); } catch (e) { throw new Error(`${FILE} non è un JSON valido`); }
  }
  const testi = Array.isArray(dati) ? dati : (Array.isArray(dati.testi) ? dati.testi : []);
  return { testi, sha: j.sha };
}

async function scriviArchivio(testi, sha, utente) {
  const corpo = {
    message: `Rapporti: aggiornamento da redazione (${utente})`,
    content: Buffer.from(JSON.stringify({ testi }, null, 2), "utf8").toString("base64"),
    branch: BRANCH
  };
  if (sha) corpo.sha = sha;
  const r = await fetch(urlFile(), { method: "PUT", headers: { ...intestazioniGh(), "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
  if (r.status === 409 || r.status === 422) {
    const e = new Error("Il file è stato modificato nel frattempo da un altro redattore: ricarica la pagina e riprova.");
    e.status = 409;
    throw e;
  }
  if (!r.ok) throw new Error(`GitHub ha risposto ${r.status} in scrittura (il GITHUB_TOKEN deve avere permesso Contents: Read and write sulla repo)`);
}

function validaTesti(testi) {
  if (!Array.isArray(testi)) return "Formato non valido.";
  if (testi.length > MAX_DOCUMENTI) return `Troppi documenti (massimo ${MAX_DOCUMENTI}).`;
  const visti = new Set();
  for (const t of testi) {
    if (!t || typeof t !== "object" || typeof t.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t.id)) return "Un documento ha un identificativo non valido.";
    if (visti.has(t.id)) return `Identificativo duplicato: ${t.id}`;
    visti.add(t.id);
    if (typeof t.titolo !== "string" || !t.titolo.trim()) return `Il documento ${t.id} non ha titolo.`;
    if (!Array.isArray(t.corpo)) return `Il documento ${t.id} non ha un corpo valido.`;
  }
  return null;
}

/* ---------- handler ---------- */

const pausa = ms => new Promise(r => setTimeout(r, ms));

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const rispondi = (stato, oggetto) => res.status(stato).json(oggetto);

  try {
    if (req.method === "GET") {
      const haToken = !!(req.headers.authorization || "").trim();
      const utente = haToken ? verificaToken(req) : null;
      if (haToken && !utente) return rispondi(401, { error: "Sessione scaduta o non valida." });
      const { testi } = await leggiArchivio();
      return rispondi(200, { testi: utente ? testi : testi.filter(t => t && t.stato === "Pubblicato") });
    }

    if (req.method === "POST") {
      const dati = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

      if (dati.azione === "login") {
        if (!SECRET) return rispondi(500, { error: "Server non configurato: manca SESSION_SECRET." });
        const elenco = utenti();
        const nome = String(dati.username || "");
        const ok = Object.prototype.hasOwnProperty.call(elenco, nome) && uguali(elenco[nome], dati.password || "");
        if (!ok) { await pausa(700); return rispondi(401, { success: false, error: "Credenziali errate" }); }
        return rispondi(200, { success: true, token: creaToken(nome) });
      }

      if (dati.azione === "salva") {
        const utente = verificaToken(req);
        if (!utente) return rispondi(401, { error: "Sessione scaduta o non valida." });
        if (!GH_TOKEN) return rispondi(500, { error: "Server non configurato: manca GITHUB_TOKEN." });
        const errore = validaTesti(dati.testi);
        if (errore) return rispondi(400, { error: errore });
        const { sha } = await leggiArchivio();
        await scriviArchivio(dati.testi, sha, utente);
        return rispondi(200, { success: true });
      }

      return rispondi(400, { error: "Azione non riconosciuta." });
    }

    res.setHeader("Allow", "GET, POST");
    return rispondi(405, { error: "Metodo non consentito." });
  } catch (e) {
    console.error(e);
    return rispondi(e.status || 500, { error: e.message || "Errore del server." });
  }
};
