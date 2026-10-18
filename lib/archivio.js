// lib/archivio.js — lettura e scrittura coerente di rapporti.json + chain.json nella repo DATA.
const { leggiHead, leggiFile, commitFiles } = require("./github");
const { leggiChain, serializza } = require("./chain");

const FILE = () => process.env.GITHUB_FILE || "rapporti.json";
const FILE_CHAIN = () => process.env.GITHUB_CHAIN_FILE || "chain.json";
// Segreto che firma i blocchi. Se cambia, i blocchi vecchi risultano "firma non valida":
// impostare CHAIN_SECRET una volta sola e non ruotarlo.
const segreto = () => process.env.CHAIN_SECRET || process.env.SESSION_SECRET || "";

function leggiTesti(testo) {
  const t = (testo || "").trim();
  if (!t) return [];
  let dati;
  try { dati = JSON.parse(t); } catch (e) { throw new Error(`${FILE()} non è un JSON valido`); }
  return Array.isArray(dati) ? dati : (Array.isArray(dati.testi) ? dati.testi : []);
}

// Solo i documenti (lettura pubblica / redazione): un file, branch corrente.
async function leggiSoloTesti() {
  return leggiTesti(await leggiFile(FILE()));
}

// Documenti e registro letti dallo STESSO commit, così sono sempre coerenti tra loro.
async function leggiStato() {
  const head = await leggiHead();
  const [t, c] = await Promise.all([leggiFile(FILE(), head), leggiFile(FILE_CHAIN(), head)]);
  return { head, testi: leggiTesti(t), chain: leggiChain(c) };
}

// Un unico commit con entrambi i file: o si salvano tutti e due, o nessuno.
async function salvaStato(head, testi, chain, messaggio) {
  return commitFiles(head, [
    { path: FILE(), content: JSON.stringify({ testi }, null, 2) },
    { path: FILE_CHAIN(), content: serializza(chain) }
  ], messaggio);
}

module.exports = { FILE, FILE_CHAIN, segreto, leggiSoloTesti, leggiStato, salvaStato };
