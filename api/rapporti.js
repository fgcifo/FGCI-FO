// api/rapporti.js — funzione serverless Vercel (endpoint /api/rapporti).
//
//   GET   (senza token)     -> { testi: [...] } solo i documenti "Pubblicato"
//   GET   (Bearer token)    -> { testi: [...] } tutti, bozze comprese
//   POST  { azione:"login", username, password }  -> { success:true, token }
//   POST  { azione:"salva", testi:[...] }  (Bearer token)
//         -> scrive rapporti.json E chain.json nella repo DATA, in un unico commit;
//            risponde { success:true, blocchi:[{index, azione, documento, hash}, ...] }
//
// Ogni salvataggio viene confrontato con lo stato precedente e ogni differenza
// (creazione, modifica, eliminazione) diventa un blocco del registro: vedi lib/chain.js.
//
// La repo DATA può essere pubblica o privata: il browser non la legge mai direttamente,
// passa sempre da questa funzione, che usa GITHUB_TOKEN (variabile d'ambiente, mai nel codice).
const { utenti, uguali, creaToken, verificaToken, haSecret } = require("../lib/auth");
const { leggiSoloTesti, leggiStato, salvaStato, segreto } = require("../lib/archivio");
const { costruisciBlocchi } = require("../lib/chain");

const MAX_DOCUMENTI = 500;

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

const pausa = ms => new Promise(r => setTimeout(r, ms));

function messaggioCommit(nuovi, utente) {
  const primo = nuovi[0], ultimo = nuovi[nuovi.length - 1];
  if (nuovi.length === 1) return `Rapporti: ${primo.azione} ${primo.documento ? primo.documento.id : "(registro)"} (${utente}) · blocco #${primo.index}`;
  return `Rapporti: ${nuovi.length} modifiche registrate (${utente}) · blocchi #${primo.index}–#${ultimo.index}`;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const rispondi = (stato, oggetto) => res.status(stato).json(oggetto);

  try {
    if (req.method === "GET") {
      const haToken = !!(req.headers.authorization || "").trim();
      const utente = haToken ? verificaToken(req) : null;
      if (haToken && !utente) return rispondi(401, { error: "Sessione scaduta o non valida." });
      const testi = await leggiSoloTesti();
      return rispondi(200, { testi: utente ? testi : testi.filter(t => t && t.stato === "Pubblicato") });
    }

    if (req.method === "POST") {
      const dati = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

      if (dati.azione === "login") {
        if (!haSecret()) return rispondi(500, { error: "Server non configurato: manca SESSION_SECRET." });
        const elenco = utenti();
        const nome = String(dati.username || "");
        const ok = Object.prototype.hasOwnProperty.call(elenco, nome) && uguali(elenco[nome], dati.password || "");
        if (!ok) { await pausa(700); return rispondi(401, { success: false, error: "Credenziali errate" }); }
        return rispondi(200, { success: true, token: creaToken(nome) });
      }

      if (dati.azione === "salva") {
        const utente = verificaToken(req);
        if (!utente) return rispondi(401, { error: "Sessione scaduta o non valida." });
        if (!process.env.GITHUB_TOKEN) return rispondi(500, { error: "Server non configurato: manca GITHUB_TOKEN." });
        if (!segreto()) return rispondi(500, { error: "Server non configurato: manca CHAIN_SECRET (o SESSION_SECRET) per firmare il registro." });
        const errore = validaTesti(dati.testi);
        if (errore) return rispondi(400, { error: errore });

        const stato = await leggiStato();
        const nuovi = costruisciBlocchi({ chain: stato.chain, salvati: stato.testi, inviati: dati.testi, utente, segreto: segreto() });
        if (!nuovi.length) return rispondi(200, { success: true, blocchi: [] });   // niente è cambiato

        await salvaStato(stato.head, dati.testi, { blocchi: stato.chain.blocchi.concat(nuovi) }, messaggioCommit(nuovi, utente));
        return rispondi(200, { success: true, blocchi: nuovi.map(b => ({ index: b.index, azione: b.azione, documento: b.documento, hash: b.hash })) });
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
