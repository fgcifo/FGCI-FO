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
//   campiModificati, modifiche, riepilogo   — le modifiche EFFETTIVE: per ogni parte cambiata, dove
//                                             (capitolo/blocco), il testo prima e il testo dopo
//   contenuto                               — solo in CREA / ELIMINA: il documento intero
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
//
// Il confronto produce una lista di MODIFICHE puntuali, ciascuna con il testo prima e dopo:
//   { sezione:"campo",  campo, dove, op:"modificato", da, a }
//   { sezione:"corpo"|"note"|"bibliografia", op:"aggiunto"|"rimosso"|"modificato"|"spostato",
//     tipo, dove, posizione, posizioneDa, da, a }
// "dove" è una descrizione leggibile della posizione, es.
//   «Paragrafo (blocco 7) · Capitolo 2 «Metodo» › Sottocapitolo 2.1 «Dati»».

const NOMI_BLOCCO = { capitolo: "Capitolo", sottocapitolo: "Sottocapitolo", paragrafo: "Paragrafo", citazione: "Citazione", elenco: "Elenco", tabella: "Tabella", riquadro: "Riquadro", immagine: "Immagine", separatore: "Separatore" };
const NOMI_CAMPO = { titolo: "Titolo", sottotitolo: "Sottotitolo", autore: "Autore", categoria: "Categoria", riferimento: "Riferimento", stato: "Stato", data: "Data", abstract: "Abstract", parole_chiave: "Parole chiave", copertina: "Copertina" };
const LIMITE_TESTO = 20000;   // oltre questa lunghezza il testo registrato viene tagliato (troncato:true)

// Copia di un valore con le stringhe troppo lunghe tagliate.
function copia(v) {
  if (typeof v === "string") return v.length > LIMITE_TESTO ? v.slice(0, LIMITE_TESTO) : v;
  if (!v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(copia);
  const o = {};
  Object.keys(v).forEach(k => { o[k] = copia(v[k]); if (typeof v[k] === "string" && v[k].length > LIMITE_TESTO) o.troncato = true; });
  return o;
}

// Descrizione della posizione di lista[i] nel corpo del testo.
function doveCorpo(lista, i) {
  let c = 0, s = 0, cap = null, sub = null;
  for (let k = 0; k <= i; k++) {
    const b = lista[k] || {};
    if (b.tipo === "capitolo") { c++; s = 0; cap = `${c} «${b.titolo || ""}»`; sub = null; }
    else if (b.tipo === "sottocapitolo") { s++; sub = `${c ? c + "." : ""}${s} «${b.titolo || ""}»`; }
  }
  const b = lista[i] || {};
  if (b.tipo === "capitolo") return `Capitolo ${cap}`;
  if (b.tipo === "sottocapitolo") return `Sottocapitolo ${sub}` + (c ? ` · nel capitolo ${cap}` : "");
  return `${NOMI_BLOCCO[b.tipo] || b.tipo || "Blocco"} (blocco ${i + 1})` + (cap ? ` · Capitolo ${cap}` : " · prima del primo capitolo") + (sub ? ` › Sottocapitolo ${sub}` : "");
}
const doveNote = (_, i) => `Nota ${i + 1}`;
const doveBiblio = (_, i) => `Riferimento bibliografico ${i + 1}`;

// Allinea due liste (sottosuccessione comune più lunga sul contenuto): restituisce le coppie
// [i, j] uguali, con i/j = indice oppure null per elementi solo di una delle due.
function allinea(A, B) {
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push([i++, null]);
    else out.push([null, j++]);
  }
  while (i < n) out.push([i++, null]);
  while (j < m) out.push([null, j++]);
  return out;
}

function diffLista(sezione, a, b, dove) {
  const A = Array.isArray(a) ? a : [], B = Array.isArray(b) ? b : [];
  const cA = A.map(canonico), cB = B.map(canonico);
  const passi = allinea(cA, cB);
  const rimossi = [], aggiunti = [], modifiche = [];
  const stessoTipo = (x, y) => x && y && (x.tipo || null) === (y.tipo || null);

  // tra due blocchi uguali, un rimosso e un aggiunto dello stesso tipo sono un blocco "modificato"
  let gapR = [], gapA = [];
  const chiudi = () => {
    const k = Math.min(gapR.length, gapA.length);
    let accoppiati = 0;
    const restoR = [], restoA = gapA.slice();
    gapR.forEach(i => {
      const pos = restoA.findIndex(j => stessoTipo(A[i], B[j]));
      if (pos >= 0 && accoppiati < k) {
        const j = restoA.splice(pos, 1)[0]; accoppiati++;
        modifiche.push({ sezione, op: "modificato", tipo: B[j].tipo || null, dove: dove(B, j), posizione: j + 1, posizioneDa: i + 1, da: copia(A[i]), a: copia(B[j]) });
      } else restoR.push(i);
    });
    restoR.forEach(i => rimossi.push(i));
    restoA.forEach(j => aggiunti.push(j));
    gapR = []; gapA = [];
  };
  passi.forEach(([i, j]) => {
    if (i !== null && j !== null) chiudi();
    else if (i !== null) gapR.push(i);
    else gapA.push(j);
  });
  chiudi();

  // un blocco tolto da una parte e identico a uno aggiunto altrove è stato SPOSTATO
  const aggLib = new Set(aggiunti);
  rimossi.forEach(i => {
    const j = [...aggLib].find(x => cB[x] === cA[i]);
    if (j !== undefined) { aggLib.delete(j); modifiche.push({ sezione, op: "spostato", tipo: A[i].tipo || null, dove: dove(B, j), posizione: j + 1, posizioneDa: i + 1, da: null, a: copia(B[j]) }); }
    else modifiche.push({ sezione, op: "rimosso", tipo: A[i].tipo || null, dove: dove(A, i), posizione: null, posizioneDa: i + 1, da: copia(A[i]), a: null });
  });
  aggLib.forEach(j => modifiche.push({ sezione, op: "aggiunto", tipo: B[j].tipo || null, dove: dove(B, j), posizione: j + 1, posizioneDa: null, da: null, a: copia(B[j]) }));

  return modifiche.sort((x, y) => (x.posizione || x.posizioneDa) - (y.posizione || y.posizioneDa));
}

function diffDocumenti(prima, dopo) {
  const chiavi = new Set([...Object.keys(prima || {}), ...Object.keys(dopo || {})]);
  chiavi.delete("id");
  const campi = [], modifiche = [];
  [...chiavi].sort().forEach(k => {
    const a = prima[k], b = dopo[k];
    if (canonico(a) === canonico(b)) return;
    let m;
    if (k === "corpo") m = diffLista("corpo", a, b, doveCorpo);
    else if (k === "note") m = diffLista("note", a, b, doveNote);
    else if (k === "bibliografia") m = diffLista("bibliografia", a, b, doveBiblio);
    else m = [{ sezione: "campo", campo: k, dove: NOMI_CAMPO[k] || k, op: "modificato", da: a == null ? null : copia(a), a: b == null ? null : copia(b) }];
    if (m.length) { campi.push(k); modifiche.push(...m); }
  });
  return { campi, modifiche };
}

function riepilogoModifica(campi, modifiche) {
  if (!campi.length) return "Nessun cambiamento di contenuto.";
  const parti = campi.map(k => {
    const mm = modifiche.filter(m => (m.sezione === "campo" ? m.campo : m.sezione) === k);
    if (mm[0].sezione === "campo") return (k === "stato" || k === "categoria") ? `${k} (${mm[0].da} → ${mm[0].a})` : k;
    const conta = ["modificato", "aggiunto", "rimosso", "spostato"].map(op => [op, mm.filter(m => m.op === op).length]).filter(x => x[1])
      .map(([op, n]) => `${n} ${op === "modificato" ? (n > 1 ? "modificati" : "modificato") : op === "aggiunto" ? (n > 1 ? "aggiunti" : "aggiunto") : op === "rimosso" ? (n > 1 ? "rimossi" : "rimosso") : (n > 1 ? "spostati" : "spostato")}`);
    return `${k} (${conta.join(", ")})`;
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
      aggiungi({ utente, azione: "CREA", documento: rif(t), hashPrima: null, hashDopo: hashDocumento(t), statoPrima: null, statoDopo: t.stato || null, campiModificati: [], contenuto: t, riepilogo: `Creato «${t.titolo}» (${t.stato || "Bozza"}).` });
      return;
    }
    const hp = hashDocumento(prima), hd = hashDocumento(t);
    if (hp === hd) return;
    const { campi, modifiche } = diffDocumenti(prima, t);
    aggiungi({ utente, azione: "MODIFICA", documento: rif(t), hashPrima: hp, hashDopo: hd, statoPrima: prima.stato || null, statoDopo: t.stato || null, campiModificati: campi, modifiche, riepilogo: riepilogoModifica(campi, modifiche) });
  });
  S.forEach((t, id) => {
    if (I.has(id)) return;
    aggiungi({ utente, azione: "ELIMINA", documento: rif(t), hashPrima: hashDocumento(t), hashDopo: null, statoPrima: t.stato || null, statoDopo: null, campiModificati: [], contenuto: t, riepilogo: `Eliminato «${t.titolo}» (contenuto conservato nel blocco).` });
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
