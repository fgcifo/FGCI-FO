// assets/js/rapporti-redazione.js — redazione di Rapporti (redazione.html).
//
// Flusso di salvataggio (identico al pattern già usato, ma più prudente):
//   1. login:   POST /api/rapporti { azione:"login", username, password }  ->  token di sessione;
//   2. salva:   prima si RILEGGE l'archivio aggiornato (bozze comprese), si sostituisce solo il testo
//               modificato (per id) e si rimanda tutta la lista con POST { azione:"salva", testi:[...] };
//               così due redattori che lavorano su testi diversi non si cancellano a vicenda;
//   3. l'endpoint scrive rapporti.json nella repo DATA (commit su GitHub).
//
// Lo stato dell'editor sta in "corrente" (un oggetto): i campi lo aggiornano mentre si scrive, la
// pagina si ridisegna solo quando cambia la struttura (blocchi aggiunti, spostati, eliminati).
(function () {
  const U = Rapporti;
  const API = U.API;
  const esc = U.escAttr;

  const STATI = ["Bozza", "Pubblicato"];
  const NOMI_BLOCCO = { capitolo: "Capitolo", sottocapitolo: "Sottocapitolo", paragrafo: "Paragrafo", citazione: "Citazione", elenco: "Elenco", tabella: "Tabella", riquadro: "Riquadro", immagine: "Immagine", separatore: "Separatore" };

  let testi = [];          // tutti i testi, bozze incluse
  let corrente = null;     // testo in modifica
  let nuovo = false;       // true finché il testo non è stato salvato la prima volta
  let sporco = false;      // modifiche non salvate
  let ultimoBlocco = null; // ultimo blocco toccato: i nuovi blocchi si inseriscono dopo di lui
  let idManuale = false;   // l'id è stato modificato a mano: smette di seguire il titolo

  const root = () => document.getElementById("redazione-root");
  const el = id => document.getElementById(id);

  function messaggio(testo, errore) {
    const m = el("redazione-messaggio");
    if (!m) return;
    m.textContent = testo || "";
    m.className = "redazione-messaggio" + (errore ? " redazione-messaggio--errore" : "");
    m.style.display = testo ? "block" : "none";
    if (testo) m.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function vuoto() {
    return {
      id: "", titolo: "", sottotitolo: "", autore: API._sessione.username || "", riferimento: "", categoria: SITE_CONFIG_RAPPORTI.categorie[0],
      stato: "Bozza", data: new Date().toISOString().slice(0, 10), abstract: "", parole_chiave: [], copertina: "",
      corpo: [{ tipo: "capitolo", titolo: "" }, { tipo: "paragrafo", testo: "" }], note: [], bibliografia: []
    };
  }

  /* ---------- LOGIN / LOGOUT ---------- */

  function mostraLogin(testoErrore) {
    el("login-area").style.display = "block";
    el("admin-content").style.display = "none";
    const err = el("loginError");
    if (testoErrore) { err.textContent = testoErrore; err.classList.add("show"); }
  }

  function mostraAdmin() {
    el("login-area").style.display = "none";
    el("admin-content").style.display = "block";
    el("adminUsernameLabel").textContent = API._sessione.username || "—";
  }

  function setupLoginUI() {
    const btn = el("loginBtn"), err = el("loginError");
    const user = el("adminUsername"), pass = el("adminPassword");
    const accedi = async () => {
      err.classList.remove("show");
      btn.disabled = true;
      try {
        await API.login(user.value.trim(), pass.value);
        pass.value = "";
        await avvia();
      } catch (e) {
        err.textContent = e.message || "Accesso non riuscito";
        err.classList.add("show");
      } finally {
        btn.disabled = false;
      }
    };
    btn.addEventListener("click", accedi);
    [user, pass].forEach(i => i.addEventListener("keydown", ev => { if (ev.key === "Enter") accedi(); }));
    el("logoutBtn").addEventListener("click", () => {
      if (sporco && !confirm("Ci sono modifiche non salvate. Uscire comunque?")) return;
      API.clearCredentials();
      sporco = false;
      testi = [];
      corrente = null;
      root().innerHTML = "";
      mostraLogin();
    });
  }

  // Sessione scaduta o non valida: torna al login senza perdere ciò che c'è nell'editor.
  function gestisciErrore(e, prefisso) {
    console.error(e);
    if (e && e.status === 401) {
      API.clearCredentials();
      mostraLogin("Sessione scaduta: accedi di nuovo (le modifiche non salvate restano nell'editor).");
      return;
    }
    messaggio((prefisso || "Errore") + ": " + (e && e.message ? e.message : "sconosciuto"), true);
  }

  /* ---------- MENU: ELENCO DEI TESTI ---------- */

  function renderMenu() {
    corrente = null;
    sporco = false;
    const righe = testi.slice().sort((a, b) => (b.data || "").localeCompare(a.data || "")).map(t => `
      <div class="redazione-riga">
        <div>
          <span class="badge-categoria">${esc(t.categoria)}</span>
          <span class="redazione-badge ${t.stato === "Pubblicato" ? "redazione-badge--pubblicato" : "redazione-badge--bozza"}">${esc(t.stato)}</span>
          <p class="redazione-riga__titolo">${esc(t.titolo)}</p>
          <p class="redazione-riga__meta">${[t.autore, U.formattaData(t.data), U.tempoLettura(t) + " min"].filter(Boolean).map(esc).join(" · ")}</p>
        </div>
        <div class="redazione-riga__azioni">
          ${t.stato === "Pubblicato" ? `<a class="redazione-btn redazione-btn--secondario redazione-btn--piccolo" href="index.html?id=${encodeURIComponent(t.id)}" target="_blank" rel="noopener">Apri</a>` : ""}
          <button type="button" class="redazione-btn redazione-btn--primario redazione-btn--piccolo" data-azione="modifica" data-id="${esc(t.id)}">Modifica</button>
          <button type="button" class="redazione-btn redazione-btn--pericolo redazione-btn--piccolo" data-azione="elimina-testo" data-id="${esc(t.id)}">Elimina</button>
        </div>
      </div>`).join("");

    root().innerHTML = `
      <div id="redazione-messaggio" class="redazione-messaggio" style="display:none;"></div>
      <div class="redazione-testa">
        <h2 class="sezione-titolo">I tuoi documenti (${testi.length})</h2>
        <button type="button" class="redazione-btn redazione-btn--primario" data-azione="nuovo-testo">+ Nuovo documento</button>
      </div>
      ${righe || `<div class="nessun-risultato">Non c'è ancora nessun testo. Crea il primo con &laquo;Nuovo testo&raquo;.</div>`}`;
  }

  /* ---------- EDITOR ---------- */

  function categoriePossibili() {
    return [...new Set([...SITE_CONFIG_RAPPORTI.categorie, ...testi.map(t => t.categoria).filter(Boolean)])];
  }

  function barraFormato(i) {
    return `<div class="redazione-formato" role="toolbar" aria-label="Formattazione">
      <button type="button" class="redazione-btn redazione-btn--piccolo redazione-btn--secondario" data-azione="fmt-b" data-blocco="${i}" title="Grassetto"><b>B</b></button>
      <button type="button" class="redazione-btn redazione-btn--piccolo redazione-btn--secondario" data-azione="fmt-i" data-blocco="${i}" title="Corsivo"><i>I</i></button>
      <button type="button" class="redazione-btn redazione-btn--piccolo redazione-btn--secondario" data-azione="fmt-link" data-blocco="${i}" title="Collegamento">Link</button>
      <button type="button" class="redazione-btn redazione-btn--piccolo redazione-btn--secondario" data-azione="fmt-nota" data-blocco="${i}" title="Inserisce un richiamo e crea una nuova nota">+ Nota</button>
    </div>`;
  }

  function htmlBlocco(b, i, numeri) {
    const numero = numeri[i] && numeri[i].num ? ` ${numeri[i].num}` : "";
    let campi = "";
    if (b.tipo === "capitolo" || b.tipo === "sottocapitolo") {
      campi = `<input type="text" data-blocco="${i}" data-campo="titolo" value="${esc(b.titolo)}" placeholder="Titolo ${b.tipo === "capitolo" ? "del capitolo" : "del sottocapitolo"}" />`;
    } else if (b.tipo === "paragrafo") {
      campi = `${barraFormato(i)}<textarea rows="7" data-blocco="${i}" data-campo="testo" placeholder="Testo. Una riga vuota separa i capoversi.">${esc(b.testo)}</textarea>`;
    } else if (b.tipo === "citazione") {
      campi = `${barraFormato(i)}<textarea rows="3" data-blocco="${i}" data-campo="testo" placeholder="Testo della citazione">${esc(b.testo)}</textarea>
        <input type="text" data-blocco="${i}" data-campo="fonte" value="${esc(b.fonte)}" placeholder="Fonte (autore, opera, anno)" />`;
    } else if (b.tipo === "elenco") {
      campi = `${barraFormato(i)}<textarea rows="5" data-blocco="${i}" data-campo="testo" placeholder="Una voce per riga">${esc(b.testo)}</textarea>
        <label class="redazione-spunta"><input type="checkbox" data-blocco="${i}" data-campo="ordinato" ${b.ordinato ? "checked" : ""} /> Elenco numerato</label>`;
    } else if (b.tipo === "tabella") {
      campi = `<textarea rows="5" data-blocco="${i}" data-campo="testo" placeholder="Una riga per riga, celle separate da |&#10;Voce | Valore | Note&#10;Entrate | 1200 | confermate">${esc(b.testo)}</textarea>
        <input type="text" data-blocco="${i}" data-campo="didascalia" value="${esc(b.didascalia)}" placeholder="Didascalia (facoltativa). La prima riga è l'intestazione." />`;
    } else if (b.tipo === "riquadro") {
      campi = `<input type="text" data-blocco="${i}" data-campo="titolo" value="${esc(b.titolo)}" placeholder="Titolo del riquadro (facoltativo)" />
        ${barraFormato(i)}<textarea rows="4" data-blocco="${i}" data-campo="testo" placeholder="Testo in evidenza (avvertenze, sintesi, decisioni)">${esc(b.testo)}</textarea>`;
    } else if (b.tipo === "separatore") {
      campi = `<p class="redazione-vuoto">Linea di separazione tra due parti del testo.</p>`;
    } else {
      campi = `<input type="text" data-blocco="${i}" data-campo="url" value="${esc(b.url)}" placeholder="URL dell'immagine" />
        <input type="text" data-blocco="${i}" data-campo="didascalia" value="${esc(b.didascalia)}" placeholder="Didascalia (facoltativa)" />`;
    }
    return `
      <div class="redazione-blocco redazione-blocco--${b.tipo}" data-indice="${i}">
        <div class="redazione-blocco__intestazione">
          <span>${NOMI_BLOCCO[b.tipo]}${numero}</span>
          <span class="redazione-blocco__strumenti">
            <button type="button" class="redazione-btn redazione-btn--piccolo redazione-btn--secondario" data-azione="su" data-blocco="${i}" title="Sposta su" ${i === 0 ? "disabled" : ""}>&uarr;</button>
            <button type="button" class="redazione-btn redazione-btn--piccolo redazione-btn--secondario" data-azione="giu" data-blocco="${i}" title="Sposta giù" ${i === corrente.corpo.length - 1 ? "disabled" : ""}>&darr;</button>
            <button type="button" class="redazione-btn redazione-btn--piccolo redazione-btn--pericolo" data-azione="elimina-blocco" data-blocco="${i}" title="Elimina">&times;</button>
          </span>
        </div>
        ${campi}
      </div>`;
  }

  function disegnaBlocchi() {
    const numeri = U.leggiCorpo(corrente);
    el("ut-blocchi").innerHTML = corrente.corpo.map((b, i) => htmlBlocco(b, i, numeri)).join("")
      || `<p class="redazione-vuoto">Il testo è vuoto: aggiungi un capitolo o un paragrafo.</p>`;
  }

  function disegnaNote() {
    el("ut-note").innerHTML = corrente.note.map((n, i) => `
      <div class="redazione-nota">
        <span class="redazione-nota__numero">${i + 1}</span>
        <textarea rows="2" data-nota="${i}" placeholder="Testo della nota (nel testo: [^${i + 1}])">${esc(n.testo)}</textarea>
        <button type="button" class="redazione-btn redazione-btn--piccolo redazione-btn--pericolo" data-azione="elimina-nota" data-i="${i}" title="Elimina la nota">&times;</button>
      </div>`).join("") || `<p class="redazione-vuoto">Nessuna nota. Usa «+ Nota» nella barra di un paragrafo per inserirne una.</p>`;
  }

  function disegnaBiblio() {
    el("ut-biblio").innerHTML = corrente.bibliografia.map((b, i) => `
      <div class="redazione-nota">
        <span class="redazione-nota__numero">&bull;</span>
        <textarea rows="2" data-biblio="${i}" placeholder="Riferimento bibliografico">${esc(b.testo)}</textarea>
        <button type="button" class="redazione-btn redazione-btn--piccolo redazione-btn--pericolo" data-azione="elimina-biblio" data-i="${i}" title="Elimina">&times;</button>
      </div>`).join("") || `<p class="redazione-vuoto">Nessun riferimento.</p>`;
  }

  function renderEditor() {
    const t = corrente;
    const statoOpz = STATI.map(s => `<option value="${s}" ${t.stato === s ? "selected" : ""}>${s}</option>`).join("");
    const catOpz = categoriePossibili().map(c => `<option value="${esc(c)}"></option>`).join("");
    const aggiungi = Object.keys(NOMI_BLOCCO).map(k =>
      `<button type="button" class="redazione-btn redazione-btn--secondario redazione-btn--piccolo" data-azione="aggiungi-blocco" data-tipo="${k}">+ ${NOMI_BLOCCO[k]}</button>`).join("");

    root().innerHTML = `
      <div id="redazione-messaggio" class="redazione-messaggio" style="display:none;"></div>
      <div class="redazione-testa">
        <h2 class="sezione-titolo">${nuovo ? "Nuovo documento" : "Modifica documento"}</h2>
        <button type="button" class="redazione-btn redazione-btn--secondario" data-azione="annulla">&larr; Elenco</button>
      </div>

      <div class="redazione-form">
        <div class="redazione-campo"><label for="m-titolo">Titolo</label>
          <input type="text" id="m-titolo" data-meta="titolo" value="${esc(t.titolo)}" /></div>
        <div class="redazione-campo"><label for="m-sottotitolo">Sottotitolo</label>
          <input type="text" id="m-sottotitolo" data-meta="sottotitolo" value="${esc(t.sottotitolo)}" /></div>
        <div class="redazione-riga-campi">
          <div class="redazione-campo"><label for="m-autore">Autore</label>
            <input type="text" id="m-autore" data-meta="autore" value="${esc(t.autore)}" /></div>
          <div class="redazione-campo"><label for="m-categoria">Categoria</label>
            <input type="text" id="m-categoria" data-meta="categoria" list="m-categorie" value="${esc(t.categoria)}" />
            <datalist id="m-categorie">${catOpz}</datalist></div>
          <div class="redazione-campo"><label for="m-data">Data</label>
            <input type="date" id="m-data" data-meta="data" value="${esc(t.data)}" /></div>
          <div class="redazione-campo"><label for="m-stato">Stato</label>
            <select id="m-stato" data-meta="stato">${statoOpz}</select></div>
        </div>
        <div class="redazione-riga-campi">
          <div class="redazione-campo"><label for="m-id">Identificativo (indirizzo)</label>
            <input type="text" id="m-id" data-meta="id" value="${esc(t.id)}" ${nuovo ? "" : "readonly"} />
            <small>Resta fisso dopo il primo salvataggio: è la parte finale del link.</small></div>
          <div class="redazione-campo"><label for="m-riferimento">Riferimento / n. protocollo</label>
            <input type="text" id="m-riferimento" data-meta="riferimento" value="${esc(t.riferimento)}" /></div>
          <div class="redazione-campo"><label for="m-copertina">Immagine di copertina (URL)</label>
            <input type="text" id="m-copertina" data-meta="copertina" value="${esc(t.copertina)}" /></div>
        </div>
        <div class="redazione-campo"><label for="m-abstract">Abstract (&laquo;In breve&raquo;)</label>
          <textarea id="m-abstract" rows="4" data-meta="abstract">${esc(t.abstract)}</textarea></div>
        <div class="redazione-campo"><label for="m-parole">Parole chiave (separate da virgola)</label>
          <input type="text" id="m-parole" data-meta="parole_chiave" value="${esc((t.parole_chiave || []).join(", "))}" /></div>

        <h3 class="redazione-sezione">Corpo del testo</h3>
        <div id="ut-blocchi"></div>
        <div class="redazione-azioni-riga">${aggiungi}</div>

        <h3 class="redazione-sezione">Note</h3>
        <div id="ut-note"></div>
        <div class="redazione-azioni-riga">
          <button type="button" class="redazione-btn redazione-btn--secondario redazione-btn--piccolo" data-azione="aggiungi-nota">+ Nota</button>
        </div>

        <h3 class="redazione-sezione">Bibliografia</h3>
        <div id="ut-biblio"></div>
        <div class="redazione-azioni-riga">
          <button type="button" class="redazione-btn redazione-btn--secondario redazione-btn--piccolo" data-azione="aggiungi-biblio">+ Riferimento</button>
        </div>

        <div class="redazione-azioni-form">
          <button type="button" class="redazione-btn redazione-btn--primario" data-azione="salva">Salva</button>
          <button type="button" class="redazione-btn redazione-btn--secondario" data-azione="anteprima">Anteprima</button>
          <button type="button" class="redazione-btn redazione-btn--secondario" data-azione="annulla">Chiudi</button>
        </div>
      </div>
      <div id="ut-anteprima"></div>`;

    disegnaBlocchi();
    disegnaNote();
    disegnaBiblio();
  }

  /* ---------- OPERAZIONI SULL'EDITOR ---------- */

  function nuovoBlocco(tipo) {
    if (tipo === "capitolo" || tipo === "sottocapitolo") return { tipo, titolo: "" };
    if (tipo === "citazione") return { tipo, testo: "", fonte: "" };
    if (tipo === "immagine") return { tipo, url: "", didascalia: "" };
    if (tipo === "elenco") return { tipo, testo: "", ordinato: false };
    if (tipo === "tabella") return { tipo, testo: "", didascalia: "" };
    if (tipo === "riquadro") return { tipo, titolo: "", testo: "" };
    if (tipo === "separatore") return { tipo };
    return { tipo: "paragrafo", testo: "" };
  }

  function campoBlocco(i, campo) {
    return root().querySelector(`[data-blocco="${i}"][data-campo="${campo}"]`);
  }

  // Inserisce testo attorno alla selezione di un paragrafo e aggiorna lo stato.
  function inserisci(i, prima, dopo) {
    const ta = campoBlocco(i, "testo");
    if (!ta) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = ta.value.slice(s, e);
    ta.value = ta.value.slice(0, s) + prima + sel + dopo + ta.value.slice(e);
    const pos = sel ? s + prima.length + sel.length + dopo.length : s + prima.length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    corrente.corpo[i].testo = ta.value;
    sporco = true;
  }

  function aggiungiNotaAlCursore(i) {
    const n = corrente.note.length + 1;
    corrente.note.push({ testo: "" });
    inserisci(i, `[^${n}]`, "");
    disegnaNote();
    const campo = root().querySelector(`[data-nota="${n - 1}"]`);
    if (campo) campo.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // Eliminando la nota N, i richiami [^N] spariscono e quelli successivi scalano di uno.
  function rinumeraRichiami(rimossa) {
    const f = s => (s || "").replace(/\[\^(\d+)\]/g, (m, n) => {
      const k = +n;
      if (k === rimossa) return "";
      return k > rimossa ? `[^${k - 1}]` : m;
    });
    corrente.abstract = f(corrente.abstract);
    corrente.corpo.forEach(b => { if (typeof b.testo === "string") b.testo = f(b.testo); });
    corrente.note.forEach(n => { n.testo = f(n.testo); });
  }

  function sposta(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= corrente.corpo.length) return;
    [corrente.corpo[i], corrente.corpo[j]] = [corrente.corpo[j], corrente.corpo[i]];
    ultimoBlocco = j;
    sporco = true;
    disegnaBlocchi();
  }

  function linkAlCursore(i) {
    const ta = campoBlocco(i, "testo");
    if (!ta) return;
    const url = prompt("Indirizzo del collegamento (https://… oppure #ancora):", "https://");
    if (!url || !url.trim() || url.trim() === "https://") return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    if (s === e) {
      const t = prompt("Testo da mostrare:", url.trim());
      if (!t) return;
      ta.setRangeText(t, s, e, "select");
      ta.setSelectionRange(s, s + t.length);
    }
    inserisci(i, `<a href="${url.trim().replace(/"/g, "&quot;")}">`, "</a>");
  }

  /* ---------- VALIDAZIONE E SALVATAGGIO ---------- */

  function costruisciTesto() {
    const t = corrente;
    const id = (t.id || "").trim();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new Error("L'identificativo deve contenere solo lettere minuscole, numeri e trattini.");
    if (!(t.titolo || "").trim()) throw new Error("Il titolo è obbligatorio.");
    if (!(t.categoria || "").trim()) throw new Error("La categoria è obbligatoria.");

    const corpo = [];
    for (const b of t.corpo) {
      if (b.tipo === "capitolo" || b.tipo === "sottocapitolo") {
        if (!(b.titolo || "").trim()) throw new Error(`Un ${NOMI_BLOCCO[b.tipo].toLowerCase()} non ha il titolo.`);
        corpo.push({ tipo: b.tipo, titolo: b.titolo.trim() });
      } else if (b.tipo === "paragrafo") {
        if ((b.testo || "").trim()) corpo.push({ tipo: "paragrafo", testo: b.testo.trim() });
      } else if (b.tipo === "citazione") {
        if ((b.testo || "").trim()) corpo.push({ tipo: "citazione", testo: b.testo.trim(), fonte: (b.fonte || "").trim() });
      } else if (b.tipo === "elenco") {
        if ((b.testo || "").trim()) corpo.push({ tipo: "elenco", testo: b.testo.trim(), ordinato: !!b.ordinato });
      } else if (b.tipo === "tabella") {
        if ((b.testo || "").trim()) corpo.push({ tipo: "tabella", testo: b.testo.trim(), didascalia: (b.didascalia || "").trim() });
      } else if (b.tipo === "riquadro") {
        if ((b.testo || "").trim()) corpo.push({ tipo: "riquadro", titolo: (b.titolo || "").trim(), testo: b.testo.trim() });
      } else if (b.tipo === "separatore") {
        corpo.push({ tipo: "separatore" });
      } else if (b.tipo === "immagine") {
        if ((b.url || "").trim()) corpo.push({ tipo: "immagine", url: b.url.trim(), didascalia: (b.didascalia || "").trim() });
      }
    }
    // le note non si scartano mai (i richiami sono numerati): una nota vuota è un errore da correggere
    const note = t.note.map((n, i) => {
      if (!(n.testo || "").trim()) throw new Error(`La nota ${i + 1} è vuota: scrivila o eliminala.`);
      return { testo: n.testo.trim() };
    });

    return {
      id, titolo: t.titolo.trim(), riferimento: (t.riferimento || "").trim(), sottotitolo: (t.sottotitolo || "").trim(), autore: (t.autore || "").trim(),
      categoria: t.categoria.trim(), stato: STATI.includes(t.stato) ? t.stato : "Bozza", data: t.data || "",
      abstract: (t.abstract || "").trim(), parole_chiave: (t.parole_chiave || []).filter(Boolean),
      copertina: (t.copertina || "").trim(), corpo, note,
      bibliografia: t.bibliografia.filter(b => (b.testo || "").trim()).map(b => ({ testo: b.testo.trim() }))
    };
  }

  async function salva(btn) {
    let pronto;
    try { pronto = costruisciTesto(); } catch (e) { messaggio(e.message, true); return; }
    btn.disabled = true;
    try {
      const fresco = await API.loadTesti(true);          // archivio aggiornato, bozze comprese
      const idx = fresco.findIndex(x => x.id === pronto.id);
      if (nuovo && idx >= 0) throw new Error("Esiste già un testo con questo identificativo: cambialo.");
      if (idx >= 0) fresco[idx] = pronto; else fresco.push(pronto);
      await API.saveTesti(fresco);
      testi = fresco;
      nuovo = false;
      sporco = false;
      const campoId = el("m-id");
      if (campoId) campoId.readOnly = true;
      messaggio(pronto.stato === "Pubblicato" ? "Salvato e pubblicato." : "Salvato come bozza.");
    } catch (e) {
      gestisciErrore(e, "Salvataggio non riuscito");
    } finally {
      btn.disabled = false;
    }
  }

  async function eliminaTesto(id) {
    const t = testi.find(x => x.id === id);
    if (!t || !confirm(`Eliminare definitivamente «${t.titolo}»?`)) return;
    try {
      const fresco = (await API.loadTesti(true)).filter(x => x.id !== id);
      await API.saveTesti(fresco);
      testi = fresco;
      renderMenu();
      messaggio("Testo eliminato.");
    } catch (e) {
      gestisciErrore(e, "Eliminazione non riuscita");
    }
  }

  function anteprima() {
    let t;
    try { t = costruisciTesto(); } catch (e) { messaggio(e.message, true); return; }
    el("ut-anteprima").innerHTML = `
      <h2 class="sezione-titolo" style="margin-top:36px;">Anteprima</h2>
      <article class="ut-lettura ut-lettura--anteprima">
        <h1 class="ut-anteprima__titolo">${esc(t.titolo)}</h1>
        ${t.sottotitolo ? `<p class="ut-testata-testo__sottotitolo">${esc(t.sottotitolo)}</p>` : ""}
        ${t.abstract ? `<div class="ut-abstract"><h2>In breve</h2><p>${U.pulisciHtml(t.abstract)}</p></div>` : ""}
        ${U.htmlCorpo(t)}${U.htmlNote(t)}${U.htmlBibliografia(t)}
      </article>`;
    el("ut-anteprima").scrollIntoView({ behavior: "smooth" });
  }

  /* ---------- EVENTI ---------- */

  function apri(testo, isNuovo) {
    corrente = JSON.parse(JSON.stringify(testo));
    corrente.note = Array.isArray(corrente.note) ? corrente.note : [];
    corrente.bibliografia = Array.isArray(corrente.bibliografia) ? corrente.bibliografia : [];
    corrente.corpo = Array.isArray(corrente.corpo) ? corrente.corpo : [];
    nuovo = isNuovo;
    ultimoBlocco = null;
    sporco = false;
    idManuale = false;
    renderEditor();
    window.scrollTo({ top: 0 });
  }

  function chiudiEditor() {
    if (sporco && !confirm("Ci sono modifiche non salvate. Chiudere comunque?")) return;
    renderMenu();
  }

  function initEventi() {
    const r = root();

    r.addEventListener("click", e => {
      const b = e.target.closest("[data-azione]");
      if (!b || b.disabled) return;
      const i = +b.dataset.blocco;
      switch (b.dataset.azione) {
        case "nuovo-testo": apri(vuoto(), true); break;
        case "modifica": { const t = testi.find(x => x.id === b.dataset.id); if (t) apri(t, false); break; }
        case "elimina-testo": eliminaTesto(b.dataset.id); break;
        case "annulla": chiudiEditor(); break;
        case "salva": salva(b); break;
        case "anteprima": anteprima(); break;
        case "aggiungi-blocco":
          { const pos = ultimoBlocco !== null && ultimoBlocco < corrente.corpo.length ? ultimoBlocco + 1 : corrente.corpo.length;
            corrente.corpo.splice(pos, 0, nuovoBlocco(b.dataset.tipo));
            ultimoBlocco = pos;
            sporco = true;
            disegnaBlocchi();
            const nodo = el("ut-blocchi").children[pos];
            const campo = nodo && nodo.querySelector("input,textarea");
            if (campo) campo.focus(); else if (nodo) nodo.scrollIntoView({ block: "center" }); }
          break;
        case "su": sposta(i, -1); break;
        case "giu": sposta(i, 1); break;
        case "elimina-blocco":
          corrente.corpo.splice(i, 1);
          ultimoBlocco = null;
          sporco = true;
          disegnaBlocchi();
          break;
        case "fmt-b": inserisci(i, "<b>", "</b>"); break;
        case "fmt-i": inserisci(i, "<i>", "</i>"); break;
        case "fmt-link": linkAlCursore(i); break;
        case "fmt-nota": aggiungiNotaAlCursore(i); break;
        case "aggiungi-nota": corrente.note.push({ testo: "" }); sporco = true; disegnaNote(); break;
        case "elimina-nota":
          if (!confirm("Eliminare la nota? I richiami nel testo verranno rinumerati.")) break;
          rinumeraRichiami(+b.dataset.i + 1);
          corrente.note.splice(+b.dataset.i, 1);
          sporco = true;
          disegnaBlocchi();
          disegnaNote();
          el("m-abstract").value = corrente.abstract;
          break;
        case "aggiungi-biblio": corrente.bibliografia.push({ testo: "" }); sporco = true; disegnaBiblio(); break;
        case "elimina-biblio": corrente.bibliografia.splice(+b.dataset.i, 1); sporco = true; disegnaBiblio(); break;
      }
    });

    r.addEventListener("input", e => {
      const f = e.target;
      if (!corrente) return;
      if (f.dataset.meta) {
        const k = f.dataset.meta;
        if (k === "parole_chiave") corrente.parole_chiave = f.value.split(/[,;]/).map(s => s.trim()).filter(Boolean);
        else corrente[k] = f.value;
        if (k === "id") idManuale = true;
        if (k === "titolo" && nuovo && !idManuale) {
          corrente.id = U.slugify(f.value);
          el("m-id").value = corrente.id;
        }
      } else if (f.dataset.blocco !== undefined && f.dataset.campo) {
        corrente.corpo[+f.dataset.blocco][f.dataset.campo] = f.type === "checkbox" ? f.checked : f.value;
      } else if (f.dataset.nota !== undefined) {
        corrente.note[+f.dataset.nota].testo = f.value;
      } else if (f.dataset.biblio !== undefined) {
        corrente.bibliografia[+f.dataset.biblio].testo = f.value;
      } else {
        return;
      }
      sporco = true;
    });

    r.addEventListener("focusin", e => {
      const bl = e.target.closest && e.target.closest(".redazione-blocco");
      if (bl) ultimoBlocco = +bl.dataset.indice;
    });

    window.addEventListener("beforeunload", ev => {
      if (sporco) { ev.preventDefault(); ev.returnValue = ""; }
    });
  }

  /* ---------- AVVIO ---------- */

  async function avvia() {
    try {
      testi = await API.loadTesti(true);
    } catch (e) {
      if (e.status === 401) { API.clearCredentials(); mostraLogin("Sessione scaduta: accedi di nuovo."); return; }
      mostraAdmin();
      root().innerHTML = `<div class="nessun-risultato">Errore nel caricamento dei testi (${esc(e.message)}).</div>`;
      return;
    }
    mostraAdmin();
    renderMenu();
  }

  function init() {
    U.renderTestata("");
    U.renderFooter();
    setupLoginUI();
    initEventi();
    if (API.isAuthenticated()) avvia(); else mostraLogin();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
