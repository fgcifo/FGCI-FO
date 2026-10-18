// lib/chain.js — registro a blocchi (blockchain permissioned) delle modifiche ai documenti.
//
// Ogni salvataggio dalla redazione genera uno o più BLOCCHI in chain.json:
//   index, timestamp, previousHash          — posizione e collegamento al blocco precedente
//   utente, azione                          — chi e che cosa: CREA | MODIFICA | ELIMINA
//                                             (+ CREA_ESTERNA | MODIFICA_ESTERNA | ELIMINA_ESTERNA,
//                                              per cambiamenti a rapporti.json fatti FUORI dal sito)
//   documento {id, titolo}                  — il documento toccato
//   hashPrima, hashDopo                     — SHA-256 del documento prima/dopo (null se non esiste)
//   statoPrima, statoDopo                   — Bozza / Pubblicato
//   campiModificati, dettagli, riepilogo    — che cosa è cambiato, in forma leggibile
//   hash                                    — SHA-256 di tutto il blocco (esclusi hash e firma)
//   firma                                   — HMAC-SHA256(hash) con CHAIN_SECRET: prova che il blocco
//                                             l'ha scritto il server; chi modifica chain.json a mano
//                                             può ricalcolare gli hash, ma non la firma.
//
// Il primo blocco è la GENESI: contiene l'hash di tutti i documenti già presenti quando il registro
// è stato attivato (baseline).
const crypto = require("crypto");

const ZERO = "0".repeat(64);
const VERSIONE = 1;

const sha256 = t => crypto.createHash("sha256").update(t, "utf8").digest("hex");
const hmac = (hash, segreto) => crypto.createHmac("sha256", segreto).update(hash).digest("hex");

// JSON canonico: chiavi ordinate, nessuno spazio. Lo stesso oggetto dà sempre lo stesso testo.
function canonico(v) {
  if (v === undefined || v === null) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonico).join(",") + "]";
  return "{" + Object.keys(v).filter(k => v[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ":" + canonico(v[k])).join(",") + "}";
}

const hashDocumento = doc => sha256(canonico(doc));
const hashBlocco = b => { const { hash, firma, ...resto } = b; return sha256(canonico(resto)); };

/* ---------- lettura / scrittura di chain.json ---------- */

// Accetta file assente o vuoto ({} / [] / testo vuoto) come registro vuoto.
// Un formato sconosciuto NON viene mai sovrascritto: meglio fermarsi che perdere dati.
function leggiChain(testo) {
  const t = (testo || "").trim();
  if (!t) return { versione: VERSIONE, blocchi: [] };
  let dati;
  try { dati = JSON.parse(t); } catch (e) { throw new Error("chain.json non è un JSON valido: correggilo a mano prima di continuare."); }
  const blocchi = Array.isArray(dati) ? dati : (dati && Array.isArray(dati.blocchi) ? dati.blocchi : null);
  const vuotoNoto = dati && typeof dati === "object" && !Array.isArray(dati) && Object.keys(dati).filter(k => k !== "versione").length === 0;
  if (!blocchi && !vuotoNoto) throw new Error("chain.json ha un formato non riconosciuto (atteso {\"versione\":1,\"blocchi\":[...]}): non lo sovrascrivo.");
  const lista = blocchi || [];
  if (lista.some(b => !b || typeof b !== "object" || typeof b.hash !== "string")) throw new Error("chain.json contiene voci che non sono blocchi: non lo sovrascrivo.");
  return { versione: VERSIONE, blocchi: lista };
}

const serializza = chain => JSON.stringify({ versione: VERSIONE, blocchi: chain.blocchi }, null, 2) + "\n";

/* ---------- confronto tra due versioni di un documento ---------- */

const breve = v => typeof v === "string" && v.length <= 120;

function diffCorpo(a, b) {
  const A = Array.isArray(a) ? a.map(canonico) : [], B = Array.isArray(b) ? b.map(canonico) : [];
  const conta = arr => arr.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
  const mA = conta(A), mB = conta(B);
  let aggiunti = 0, rimossi = 0;
  mB.forEach((n, k) => { aggiunti += Math.max(0, n - (mA.get(k) || 0)); });
  mA.forEach((n, k) => { rimossi += Math.max(0, n - (mB.get(k) || 0)); });
  return { blocchiPrima: A.length, blocchiDopo: B.length, aggiunti, rimossi, riordinato: !aggiunti && !rimossi };
}

function diffDocumenti(prima, dopo) {
  const chiavi = new Set([...Object.keys(prima || {}), ...Object.keys(dopo || {})]);
  chiavi.delete("id");
  const campi = [], dettagli = {};
  [...chiavi].sort().forEach(k => {
    const a = prima[k], b = dopo[k];
    if (canonico(a) === canonico(b)) return;
    campi.push(k);
    if (k === "corpo") dettagli.corpo = diffCorpo(a, b);
    else if (k === "parole_chiave") dettagli[k] = { da: a || [], a: b || [] };
    else if (Array.isArray(a) || Array.isArray(b)) dettagli[k] = { vociPrima: (a || []).length, vociDopo: (b || []).length };
    else if ((a == null || breve(a)) && (b == null || breve(b))) dettagli[k] = { da: a == null ? null : a, a: b == null ? null : b };
    else dettagli[k] = { lunghezzaPrima: String(a == null ? "" : a).length, lunghezzaDopo: String(b == null ? "" : b).length };
  });
  return { campi, dettagli };
}

function riepilogoModifica(campi, dettagli) {
  if (!campi.length) return "Nessun cambiamento di contenuto.";
  const parti = campi.map(k => {
    const d = dettagli[k];
    if (k === "corpo") return d.riordinato ? "corpo (blocchi riordinati)" : `corpo (+${d.aggiunti}/−${d.rimossi} blocchi)`;
    if (d && "da" in d && !Array.isArray(d.da) && (k === "stato" || k === "categoria")) return `${k} (${d.da} → ${d.a})`;
    return k;
  });
  return "Modificati: " + parti.join(", ") + ".";
}

/* ---------- stato dedotto dalla catena ---------- */

// Mappa id → hash che i documenti DOVREBBERO avere, secondo il registro.
function statoDaCatena(blocchi) {
  const m = new Map();
  blocchi.forEach(b => {
    if (b.azione === "GENESI") { Object.entries((b.baseline && b.baseline.documenti) || {}).forEach(([id, h]) => m.set(id, h)); return; }
    if (!b.documento) return;
    if (b.hashDopo == null) m.delete(b.documento.id); else m.set(b.documento.id, b.hashDopo);
  });
  return m;
}

/* ---------- costruzione dei nuovi blocchi ---------- */

function nuovoBlocco(blocchi, dati, segreto) {
  const index = blocchi.length;
  const base = { index, timestamp: new Date().toISOString(), previousHash: index ? blocchi[index - 1].hash : ZERO, ...dati };
  const hash = sha256(canonico(base));
  return { ...base, hash, firma: hmac(hash, segreto) };
}

const idx = lista => new Map(lista.map(t => [t.id, t]));
const rif = t => ({ id: t.id, titolo: t.titolo });

// chain: registro letto; salvati: documenti attualmente in rapporti.json; inviati: lista che il redattore vuole salvare.
// Restituisce SOLO i blocchi nuovi (già collegati ai precedenti). Lista vuota = niente da registrare.
function costruisciBlocchi({ chain, salvati, inviati, utente, segreto }) {
  const tutti = chain.blocchi.slice();
  const nuovi = [];
  const aggiungi = dati => { const b = nuovoBlocco(tutti, dati, segreto); tutti.push(b); nuovi.push(b); };

  const S = idx(salvati), I = idx(inviati);

  if (!tutti.length) {
    const documenti = {};
    salvati.forEach(t => { documenti[t.id] = hashDocumento(t); });
    aggiungi({ utente: "sistema", azione: "GENESI", documento: null, baseline: { documenti },
      riepilogo: `Registro attivato: ${salvati.length} documenti già presenti registrati come stato iniziale.` });
  } else {
    // Qualcuno ha toccato rapporti.json senza passare dal sito? Lo mettiamo agli atti prima di procedere.
    const atteso = statoDaCatena(tutti);
    S.forEach((t, id) => {
      const h = hashDocumento(t);
      if (!atteso.has(id)) aggiungi({ utente: "(esterno)", azione: "CREA_ESTERNA", documento: rif(t), hashPrima: null, hashDopo: h, statoPrima: null, statoDopo: t.stato || null, riepilogo: "Documento comparso in rapporti.json fuori dal sito." });
      else if (atteso.get(id) !== h) aggiungi({ utente: "(esterno)", azione: "MODIFICA_ESTERNA", documento: rif(t), hashPrima: atteso.get(id), hashDopo: h, statoPrima: null, statoDopo: t.stato || null, riepilogo: "Documento modificato in rapporti.json fuori dal sito." });
    });
    atteso.forEach((h, id) => {
      if (!S.has(id)) aggiungi({ utente: "(esterno)", azione: "ELIMINA_ESTERNA", documento: { id, titolo: null }, hashPrima: h, hashDopo: null, statoPrima: null, statoDopo: null, riepilogo: "Documento sparito da rapporti.json fuori dal sito." });
    });
  }

  inviati.forEach(t => {
    const prima = S.get(t.id);
    if (!prima) {
      aggiungi({ utente, azione: "CREA", documento: rif(t), hashPrima: null, hashDopo: hashDocumento(t), statoPrima: null, statoDopo: t.stato || null, campiModificati: [], riepilogo: `Creato «${t.titolo}» (${t.stato || "Bozza"}).` });
      return;
    }
    const hp = hashDocumento(prima), hd = hashDocumento(t);
    if (hp === hd) return;
    const { campi, dettagli } = diffDocumenti(prima, t);
    aggiungi({ utente, azione: "MODIFICA", documento: rif(t), hashPrima: hp, hashDopo: hd, statoPrima: prima.stato || null, statoDopo: t.stato || null, campiModificati: campi, dettagli, riepilogo: riepilogoModifica(campi, dettagli) });
  });
  S.forEach((t, id) => {
    if (I.has(id)) return;
    aggiungi({ utente, azione: "ELIMINA", documento: rif(t), hashPrima: hashDocumento(t), hashDopo: null, statoPrima: t.stato || null, statoDopo: null, campiModificati: [], riepilogo: `Eliminato «${t.titolo}».` });
  });

  return nuovi;
}

/* ---------- verifica ---------- */

function verificaCatena(blocchi, segreto) {
  const problemi = [];
  const male = (index, motivo) => problemi.push({ index, motivo });
  blocchi.forEach((b, i) => {
    if (b.index !== i) male(i, `posizione dichiarata ${b.index}, attesa ${i}`);
    if (b.previousHash !== (i ? blocchi[i - 1].hash : ZERO)) male(i, "il collegamento al blocco precedente non torna (blocco inserito, tolto o modificato)");
    if (hashBlocco(b) !== b.hash) male(i, "il contenuto non corrisponde al suo hash (blocco modificato)");
    if (segreto) {
      const f = typeof b.firma === "string" ? b.firma : "";
      const atteso = hmac(b.hash, segreto);
      if (f.length !== atteso.length || !crypto.timingSafeEqual(Buffer.from(f), Buffer.from(atteso))) male(i, "firma non valida (blocco non scritto dal server)");
    }
    if (i && b.timestamp < blocchi[i - 1].timestamp) male(i, "data anteriore a quella del blocco precedente");
  });
  return { valida: problemi.length === 0, firmeVerificate: !!segreto, problemi };
}

// Confronta i documenti realmente presenti con quelli che il registro si aspetta.
function verificaCoerenza(blocchi, testi) {
  const atteso = statoDaCatena(blocchi), diff = [];
  const presenti = idx(testi);
  presenti.forEach((t, id) => {
    if (!atteso.has(id)) diff.push({ id, problema: "documento non registrato" });
    else if (atteso.get(id) !== hashDocumento(t)) diff.push({ id, problema: "contenuto diverso da quello registrato" });
  });
  atteso.forEach((_, id) => { if (!presenti.has(id)) diff.push({ id, problema: "documento registrato ma assente" }); });
  return { coerente: diff.length === 0, differenze: diff };
}

module.exports = { ZERO, VERSIONE, canonico, hashDocumento, hashBlocco, leggiChain, serializza, diffDocumenti, statoDaCatena, costruisciBlocchi, verificaCatena, verificaCoerenza };
