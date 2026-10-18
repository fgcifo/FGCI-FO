// api/chain.js — consultazione e verifica del registro a blocchi (endpoint /api/chain).
//
//   GET  (senza token)   -> riepilogo pubblico: { valida, coerente, blocchi, ultimoHash, ultimoAggiornamento }
//                           (nessun titolo, autore o contenuto: le bozze restano riservate)
//   GET  (Bearer token)  -> registro completo: { blocchi:[...], verifica, coerenza }
//
// "valida"   = la catena di hash e le firme sono integre.
// "coerente" = i documenti in rapporti.json corrispondono a quelli che il registro si aspetta
//              (se no, qualcuno ha modificato rapporti.json fuori dal sito).
const { verificaToken } = require("../lib/auth");
const { leggiStato, segreto } = require("../lib/archivio");
const { verificaCatena, verificaCoerenza } = require("../lib/chain");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const rispondi = (stato, oggetto) => res.status(stato).json(oggetto);
  try {
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return rispondi(405, { error: "Metodo non consentito." }); }

    const haToken = !!(req.headers.authorization || "").trim();
    const utente = haToken ? verificaToken(req) : null;
    if (haToken && !utente) return rispondi(401, { error: "Sessione scaduta o non valida." });

    const { chain, testi } = await leggiStato();
    const verifica = verificaCatena(chain.blocchi, segreto());
    const coerenza = verificaCoerenza(chain.blocchi, testi);
    const ultimo = chain.blocchi[chain.blocchi.length - 1] || null;

    if (!utente) {
      return rispondi(200, {
        valida: verifica.valida, coerente: chain.blocchi.length ? coerenza.coerente : null, blocchi: chain.blocchi.length,
        ultimoHash: ultimo ? ultimo.hash : null, ultimoAggiornamento: ultimo ? ultimo.timestamp : null
      });
    }
    return rispondi(200, { blocchi: chain.blocchi, verifica, coerenza: chain.blocchi.length ? coerenza : { coerente: null, differenze: [] } });
  } catch (e) {
    console.error(e);
    return rispondi(e.status || 500, { error: e.message || "Errore del server." });
  }
};
