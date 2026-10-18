// assets/js/rapporti-registro.js — registro delle modifiche (registro.html).
// Mostra la catena di blocchi di chain.json: chi ha fatto che cosa e quando, con l'esito della verifica
// d'integrità eseguita dal server. ?id=<documento> filtra la cronologia di un solo documento.
(function () {
  const U = Rapporti, esc = U.escAttr;
  const ETICHETTE = { GENESI: "Avvio registro", CREA: "Creato", MODIFICA: "Modificato", ELIMINA: "Eliminato",
    CREA_ESTERNA: "Creato fuori sito", MODIFICA_ESTERNA: "Modificato fuori sito", ELIMINA_ESTERNA: "Eliminato fuori sito" };
  const root = () => document.getElementById("registro-root");
  const corto = h => (h ? h.slice(0, 10) + "…" : "—");
  let dati = null;

  function dataOra(iso) {
    const d = new Date(iso);
    return isNaN(d) ? esc(iso) : d.toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" });
  }

  function banner() {
    const v = dati.verifica, c = dati.coerenza;
    const righe = [];
    righe.push(v.valida
      ? `<p class="registro-esito registro-esito--ok">✔ Catena integra: ${dati.blocchi.length} blocchi collegati${v.firmeVerificate ? " e firmati dal server" : ""}.</p>`
      : `<p class="registro-esito registro-esito--ko">✖ Catena compromessa: ${v.problemi.map(p => `blocco #${p.index}: ${esc(p.motivo)}`).join("; ")}.</p>`);
    if (c.coerente === false) {
      righe.push(`<p class="registro-esito registro-esito--ko">✖ I documenti non corrispondono al registro (${c.differenze.map(d => `${esc(d.id)}: ${esc(d.problema)}`).join("; ")}). Verranno messi agli atti come «fuori sito» al prossimo salvataggio.</p>`);
    } else if (c.coerente === true) {
      righe.push(`<p class="registro-esito registro-esito--ok">✔ I documenti attuali corrispondono al registro.</p>`);
    }
    return righe.join("");
  }

  function dettagli(b) {
    const righe = [];
    if (b.campiModificati && b.campiModificati.length) righe.push(`<li>Campi: ${b.campiModificati.map(esc).join(", ")}</li>`);
    if (b.dettagli && b.dettagli.corpo) { const c = b.dettagli.corpo; righe.push(`<li>Corpo: ${c.blocchiPrima} → ${c.blocchiDopo} blocchi (+${c.aggiunti}/−${c.rimossi})</li>`); }
    if (b.statoPrima !== b.statoDopo && (b.statoPrima || b.statoDopo)) righe.push(`<li>Stato: ${esc(b.statoPrima || "—")} → ${esc(b.statoDopo || "—")}</li>`);
    righe.push(`<li>Hash del documento prima: <code>${esc(b.hashPrima || "—")}</code></li>`);
    righe.push(`<li>Hash del documento dopo: <code>${esc(b.hashDopo || "—")}</code></li>`);
    righe.push(`<li>Hash del blocco: <code>${esc(b.hash)}</code></li>`);
    righe.push(`<li>Blocco precedente: <code>${esc(b.previousHash)}</code></li>`);
    return `<details class="registro-dettagli"><summary>Dettagli tecnici</summary><ul>${righe.join("")}</ul></details>`;
  }

  function scheda(b) {
    const doc = b.documento;
    const titolo = doc ? `${esc(doc.titolo || doc.id)} <span class="registro-id">(${esc(doc.id)})</span>` : "Registro";
    return `<article class="registro-blocco registro-blocco--${esc(b.azione.toLowerCase())}">
      <div class="registro-blocco__testa">
        <span class="registro-n">#${b.index}</span>
        <span class="redazione-badge registro-azione">${esc(ETICHETTE[b.azione] || b.azione)}</span>
        <strong>${titolo}</strong>
      </div>
      <p class="registro-meta">${esc(b.utente)} · ${dataOra(b.timestamp)}</p>
      <p>${esc(b.riepilogo || "")}</p>
      ${dettagli(b)}
    </article>`;
  }

  function disegna() {
    const id = new URLSearchParams(location.search).get("id") || "";
    const blocchi = dati.blocchi.filter(b => !id || (b.documento && b.documento.id === id)).slice().reverse();
    const filtro = id ? `<p>Cronologia del documento <strong>${esc(id)}</strong> · <a href="registro.html">mostra tutto il registro</a></p>` : "";
    root().innerHTML = `${banner()}${filtro}
      <p><button type="button" class="redazione-btn redazione-btn--secondario redazione-btn--piccolo" id="scarica">Scarica chain.json</button></p>
      ${blocchi.map(scheda).join("") || `<div class="nessun-risultato">Nessuna modifica registrata${id ? " per questo documento" : " (il registro si attiva al primo salvataggio)"}.</div>`}`;
    document.getElementById("scarica").addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify({ versione: 1, blocchi: dati.blocchi }, null, 2)], { type: "application/json" }));
      a.download = "chain.json";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  async function init() {
    U.renderTestata("");
    U.renderFooter();
    if (!U.API.isAuthenticated()) {
      root().innerHTML = `<div class="nessun-risultato">Per consultare il registro devi accedere dalla <a href="redazione.html">redazione</a>.</div>`;
      return;
    }
    try {
      dati = await U.API.loadRegistro();
      disegna();
    } catch (e) {
      root().innerHTML = `<div class="nessun-risultato">${e.status === 401 ? `Sessione scaduta: accedi di nuovo dalla <a href="redazione.html">redazione</a>.` : "Errore nel caricamento del registro (" + esc(e.message) + ")."}</div>`;
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
