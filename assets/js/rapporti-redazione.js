// assets/js/rapporti-redazione.js — redazione di Rapporti (redazione.html).
//
// NUOVO EDITOR A DUE COLONNE (come la Redazione Wiki):
//   · a sinistra l'ANTEPRIMA dell'articolo, che si aggiorna mentre scrivi;
//   · a destra la zona dove SCRIVERE il testo, con colori (un livello <pre> colorato dietro la textarea).
// Il vecchio sistema a "blocchi" con un campo per ciascuno è stato rimosso: il documento è un unico testo.
//
// SINTASSI DEL TESTO (si converte avanti e indietro da/verso la struttura salvata in rapporti.json,
// quindi l'endpoint /api/rapporti e i documenti già esistenti NON cambiano):
//   # Titolo                   capitolo            ## Titolo   sottocapitolo
//   testo normale              paragrafo (riga vuota = nuovo capoverso; a capo semplice = <br>)
//   > citazione                (più righe > ; riga ">" sola = nuovo capoverso)     >> Fonte
//   - voce  /  1. voce         elenco puntato / numerato (una voce per riga)
//   {{tabella Didascalia       righe con celle separate da |  (la prima riga è l'intestazione)
//   Voce | Valore
//   }}
//   {{riquadro Titolo          riquadro di evidenza, testo libero
//   ...
//   }}
//   ![didascalia](https://…)   immagine           ---   separatore
//   testo<sup>…</sup> [^1]     richiamo di nota    [^1]: testo della nota   (definizione, ovunque)
//   {{bibliografia             un riferimento per riga, con "- " davanti
//   - Rossi, 2020…
//   }}
//   Dentro il testo: <b>grassetto</b> · <i>corsivo</i> · <a href="https://…">link</a>
//   Una riga di testo che inizia con un simbolo speciale si protegge con "\" davanti (lo fa da solo il convertitore).
//
// Salvataggio: identico a prima. Si RILEGGE l'archivio aggiornato (bozze comprese), si sostituisce solo
// il documento modificato (per id) e si rimanda la lista con POST { azione:"salva", testi:[...] }.
(function () {
  const U = Rapporti;
  const API = U.API;
  const esc = U.escAttr;

  const STATI = ["Bozza", "Pubblicato"];

  let testi = [];          // tutti i documenti, bozze incluse
  let corrente = null;     // metadati del documento in modifica (il testo sta nella textarea #rx-ta)
  let nuovo = false;       // true finché il documento non è stato salvato la prima volta
  let sporco = false;      // modifiche non salvate
  let idManuale = false;   // l'id è stato modificato a mano: smette di seguire il titolo
  let tAnt = null;         // timer dell'anteprima

  const root = () => document.getElementById("redazione-root");
  const el = id => document.getElementById(id);
  const ta = () => el("rx-ta");

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
      corpo: [{ tipo: "capitolo", titolo: "Primo capitolo" }, { tipo: "paragrafo", testo: "Scrivi qui il testo." }], note: [], bibliografia: []
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
      ${righe || `<div class="nessun-risultato">Non c'è ancora nessun testo. Crea il primo con &laquo;Nuovo documento&raquo;.</div>`}`;
  }

  /* =====================================================================
     CONVERSIONE  struttura (corpo / note / bibliografia)  <->  testo dell'editor
     ===================================================================== */

  // Una riga di paragrafo che comincia con un simbolo speciale si protegge con "\" (e si ripristina leggendo).
  const SPECIAL = /^(\\*)(#|>|[-*]\s|-{3,}\s*$|\d+\.\s|\{\{|!\[|\[\^\d+\]:)/;
  const escRiga = l => { const t = l.trim(); return SPECIAL.test(t) ? "\\" + t : t; };
  const unescRiga = t => { const m = SPECIAL.exec(t); return m && m[1] ? t.slice(1) : t; };
  const una = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const righe = s => String(s == null ? "" : s).replace(/\r\n?/g, "\n").split("\n");
  const flat = s => String(s == null ? "" : s).replace(/\r/g, "").replace(/\s*\n\s*/g, "<br>").trim();

  function sorgenteDa(t) {
    const out = [];
    (Array.isArray(t.corpo) ? t.corpo : []).forEach(b => {
      if (!b || typeof b !== "object") return;
      switch (b.tipo) {
        case "capitolo": out.push("# " + una(b.titolo)); break;
        case "sottocapitolo": out.push("## " + una(b.titolo)); break;
        case "citazione": {
          const l = righe(b.testo).map(x => x.trim() ? "> " + x.trim() : ">");
          if ((b.fonte || "").trim()) l.push(">> " + una(b.fonte));
          out.push(l.join("\n")); break;
        }
        case "elenco": out.push(U.righeElenco(b).map((v, i) => (b.ordinato ? (i + 1) + ". " : "- ") + v).join("\n")); break;
        case "tabella": out.push(["{{tabella" + (b.didascalia ? " " + una(b.didascalia) : ""), ...U.righeElenco(b), "}}"].join("\n")); break;
        case "riquadro": out.push(["{{riquadro" + (b.titolo ? " " + una(b.titolo) : ""), ...righe(b.testo).map(x => x.trim() === "}}" ? "\\}}" : x.trim()), "}}"].join("\n")); break;
        case "immagine": out.push(`![${una(b.didascalia).replace(/[\[\]]/g, " ")}](${String(b.url || "").trim()})`); break;
        case "separatore": out.push("---"); break;
        default: out.push(righe(b.testo).map(l => l.trim() ? escRiga(l) : "").join("\n").trim());
      }
    });
    const note = Array.isArray(t.note) ? t.note : [];
    if (note.length) out.push(note.map((n, i) => `[^${i + 1}]: ${flat(n && n.testo)}`).join("\n"));
    const bib = U.biblioDi(t);
    if (bib.length) out.push(["{{bibliografia", ...bib.map(b => "- " + flat(b.testo)), "}}"].join("\n"));
    return out.filter(Boolean).join("\n\n") + "\n";
  }

  // Legge il testo dell'editor. strict = true (salvataggio): gli errori bloccano; strict = false (anteprima): diventano avvisi.
  function leggiSorgente(src, strict) {
    const L = String(src || "").replace(/\r/g, "").split("\n");
    const corpo = [], defs = {}, bibliografia = [], avvisi = [];
    let par = [];
    const errore = m => { if (strict) throw new Error(m); avvisi.push(m); };
    const flush = () => { if (par.length) { corpo.push({ tipo: "paragrafo", testo: par.join("\n") }); par = []; } };

    for (let i = 0; i < L.length; i++) {
      const r = L[i].trim();
      let m;
      if (!r) { flush(); continue; }

      if ((m = /^\{\{\s*(tabella|riquadro|bibliografia)\b\s*(.*?)\s*(\}\})?$/i.exec(r))) {
        flush();
        const k = m[1].toLowerCase(), tit = una(m[2]), inner = [];
        if (!m[3]) {
          i++;
          while (i < L.length && L[i].trim() !== "}}") { inner.push(L[i]); i++; }
          if (i >= L.length) errore(`Il blocco «${k}» non è chiuso con }}.`);
        }
        if (k === "tabella") {
          const rr = inner.map(x => x.trim()).filter(Boolean);
          if (rr.length) corpo.push({ tipo: "tabella", testo: rr.join("\n"), didascalia: tit });
        } else if (k === "riquadro") {
          const tx = inner.map(x => x.trim() === "\\}}" ? "}}" : x.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
          if (tx) corpo.push({ tipo: "riquadro", titolo: tit, testo: tx });
        } else {
          inner.map(x => x.trim().replace(/^[-*]\s+/, "")).filter(Boolean).forEach(x => bibliografia.push({ testo: x }));
        }
        continue;
      }
      if (/^---+$/.test(r)) { flush(); corpo.push({ tipo: "separatore" }); continue; }
      if ((m = /^(#{1,2})(?:\s+(.*))?$/.exec(r))) {
        flush();
        const tipo = m[1].length === 1 ? "capitolo" : "sottocapitolo", titolo = una(m[2]);
        if (!titolo) errore(`Un ${tipo} non ha il titolo (riga ${i + 1}).`);
        corpo.push({ tipo, titolo });
        continue;
      }
      if (r[0] === ">") {
        flush();
        const tx = []; let fonte = "";
        while (i < L.length && L[i].trim()[0] === ">") {
          const x = L[i].trim(); let k;
          if ((k = /^>>\s?(.*)$/.exec(x))) fonte = k[1].trim(); else tx.push(x.replace(/^>\s?/, "").trim());
          i++;
        }
        i--;
        const testo = tx.join("\n").replace(/\n{3,}/g, "\n\n").trim();
        if (testo) corpo.push({ tipo: "citazione", testo, fonte });
        continue;
      }
      if (/^([-*]|\d+\.)\s+/.test(r)) {
        flush();
        const ordinato = /^\d/.test(r), voci = [];
        while (i < L.length && /^([-*]|\d+\.)\s+/.test(L[i].trim())) { voci.push(L[i].trim().replace(/^([-*]|\d+\.)\s+/, "")); i++; }
        i--;
        corpo.push({ tipo: "elenco", testo: voci.join("\n"), ordinato });
        continue;
      }
      if ((m = /^!\[([^\]]*)\]\((\S+?)\)$/.exec(r))) { flush(); corpo.push({ tipo: "immagine", url: m[2], didascalia: m[1].trim() }); continue; }
      if ((m = /^\[\^(\d+)\]:\s*(.*)$/.exec(r))) {
        flush();
        if (defs[m[1]] !== undefined) errore(`La nota [^${m[1]}] è definita due volte.`);
        defs[m[1]] = m[2].trim();
        continue;
      }
      par.push(unescRiga(r));
    }
    flush();

    // note: devono essere numerate 1..N senza salti
    const numeri = Object.keys(defs).map(Number), max = numeri.length ? Math.max(...numeri) : 0, note = [];
    for (let n = 1; n <= max; n++) {
      if (defs[n] === undefined) { errore(`Manca la nota [^${n}] (le note vanno numerate [^1], [^2]… senza salti).`); note.push({ testo: "" }); }
      else {
        if (!defs[n]) errore(`La nota ${n} è vuota: scrivila o eliminala.`);
        note.push({ testo: defs[n] });
      }
    }
    return { corpo, note, bibliografia, avvisi, max };
  }

  /* ---------- evidenziazione colorata (livello <pre> dietro la textarea) ---------- */

  const E = esc;
  const RXI = /(<a\s[^>]*>[\s\S]*?<\/a>)|(<b>[\s\S]*?<\/b>)|(<i>[\s\S]*?<\/i>)|(\[\^\d+\])|(<\/?[a-z][^>]*>)/gi;
  const CLI = ["", "h-url", "h-b", "h-i", "h-nota", "h-tag"];
  const tok = s => {
    RXI.lastIndex = 0;
    let o = "", k = 0, m;
    while ((m = RXI.exec(s))) {
      o += E(s.slice(k, m.index));
      o += `<span class="${CLI[m.findIndex((x, i) => i > 0 && x !== undefined)]}">${E(m[0])}</span>`;
      k = m.index + m[0].length;
    }
    return o + E(s.slice(k));
  };

  function evidenzia() {
    const t = ta(), h = el("rx-hl");
    if (!t || !h) return;
    let blk = null, m;
    const out = t.value.replace(/\r/g, "").split("\n").map(l => {
      const r = l.trim();
      if (blk) {
        if (r === "}}") { blk = null; return `<span class="h-ib">${E(l)}</span>`; }
        if (blk === "tabella") return l.split("|").map((c, i) => (i ? '<span class="h-p">|</span>' : "") + tok(c)).join("");
        if (blk === "bibliografia" && (m = /^(\s*[-*]\s)(.*)$/.exec(l))) return `<span class="h-li">${E(m[1])}</span>` + tok(m[2]);
        return tok(l);
      }
      if ((m = /^\{\{\s*(tabella|riquadro|bibliografia)\b/i.exec(r))) { blk = /\}\}\s*$/.test(r) ? null : m[1].toLowerCase(); return `<span class="h-ib">${E(l)}</span>`; }
      if (r[0] === "\\") return tok(l);
      if (/^##(\s|$)/.test(r)) return `<span class="h-h3">${tok(l)}</span>`;
      if (/^#(\s|$)/.test(r)) return `<span class="h-h2">${tok(l)}</span>`;
      if (/^---+$/.test(r)) return `<span class="h-hr">${E(l)}</span>`;
      if (/^>>/.test(r)) return `<span class="h-lab">${tok(l)}</span>`;
      if (r[0] === ">") return `<span class="h-q">${tok(l)}</span>`;
      if (/^!\[[^\]]*\]\(\S+?\)$/.test(r)) return `<span class="h-img">${E(l)}</span>`;
      if ((m = /^(\s*\[\^\d+\]:)(.*)$/.exec(l))) return `<span class="h-nota">${E(m[1])}</span>` + tok(m[2]);
      if ((m = /^(\s*(?:[-*]|\d+\.))(\s.*)$/.exec(l))) return `<span class="h-li">${E(m[1])}</span>` + tok(m[2]);
      return tok(l);
    });
    h.innerHTML = out.join("\n") + "\n ";
    h.scrollTop = t.scrollTop;
    h.scrollLeft = t.scrollLeft;
  }

  /* ---------- anteprima dell'articolo (stesso rendering della pagina pubblica) ---------- */

  function aggiornaAnteprima() {
    const art = el("rx-art");
    if (!art || !corrente) return;
    const p = leggiSorgente(ta().value, false);
    const t = { titolo: corrente.titolo, sottotitolo: corrente.sottotitolo, abstract: corrente.abstract, corpo: p.corpo, note: p.note, bibliografia: p.bibliografia };

    // richiami senza nota
    const avvisi = p.avvisi.slice();
    const pezzi = [t.abstract];
    p.corpo.forEach(b => { if (typeof b.testo === "string") pezzi.push(b.testo); });
    const usati = new Set();
    pezzi.join("\n").replace(/\[\^(\d+)\]/g, (m, n) => { usati.add(+n); return m; });
    [...usati].sort((a, b) => a - b).forEach(n => { if (n > p.note.length) avvisi.push(`Il richiamo [^${n}] non ha una nota.`); });

    art.innerHTML = `
      <h1 class="ut-anteprima__titolo">${esc(t.titolo) || '<span class="rx-vuoto">(senza titolo)</span>'}</h1>
      ${t.sottotitolo ? `<p class="ut-testata-testo__sottotitolo">${esc(t.sottotitolo)}</p>` : ""}
      ${t.abstract ? `<div class="ut-abstract"><h2>In breve</h2><p>${U.pulisciHtml(t.abstract)}</p></div>` : ""}
      ${U.htmlIndice(t)}${U.htmlCorpo(t)}${U.htmlNote(t)}${U.htmlBibliografia(t)}`;
    const av = el("rx-avvisi");
    if (av) av.textContent = avvisi.length ? "⚠ " + avvisi.join(" · ") : "";
  }
  const rinviaAnteprima = () => { clearTimeout(tAnt); tAnt = setTimeout(aggiornaAnteprima, 120); };

  /* ---------- EDITOR ---------- */

  function categoriePossibili() {
    return [...new Set([...SITE_CONFIG_RAPPORTI.categorie, ...testi.map(t => t.categoria).filter(Boolean)])];
  }

  const BTN = "redazione-btn redazione-btn--piccolo redazione-btn--secondario";

  function renderEditor(sorgente) {
    const t = corrente;
    const statoOpz = STATI.map(s => `<option value="${s}" ${t.stato === s ? "selected" : ""}>${s}</option>`).join("");
    const catOpz = categoriePossibili().map(c => `<option value="${esc(c)}"></option>`).join("");

    root().innerHTML = `
      <div id="redazione-messaggio" class="redazione-messaggio" style="display:none;"></div>
      <div class="redazione-testa">
        <h2 class="sezione-titolo">${nuovo ? "Nuovo documento" : "Modifica documento"}</h2>
        <button type="button" class="redazione-btn redazione-btn--secondario" data-azione="annulla">&larr; Elenco</button>
      </div>

      <details class="rx-meta" open>
        <summary>Dati del documento</summary>
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
            <textarea id="m-abstract" rows="3" data-meta="abstract">${esc(t.abstract)}</textarea></div>
          <div class="redazione-campo"><label for="m-parole">Parole chiave (separate da virgola)</label>
            <input type="text" id="m-parole" data-meta="parole_chiave" value="${esc((t.parole_chiave || []).join(", "))}" /></div>
        </div>
      </details>

      <div class="rx-split">
        <div class="rx-colprev">
          <div class="rx-label">Anteprima</div>
          <div class="rx-prev"><article class="ut-lettura ut-lettura--anteprima" id="rx-art"></article></div>
          <p class="rx-avvisi" id="rx-avvisi"></p>
        </div>
        <div class="rx-coled">
          <div class="rx-label">Testo</div>
          <div class="rx-tools" id="rx-tools" role="toolbar" aria-label="Formattazione">
            <button type="button" class="${BTN}" data-rx="b" title="Grassetto"><b>B</b></button>
            <button type="button" class="${BTN}" data-rx="i" title="Corsivo"><i>I</i></button>
            <button type="button" class="${BTN}" data-rx="link" title="Collegamento">Link</button>
            <button type="button" class="${BTN}" data-rx="nota" title="Inserisce un richiamo e crea una nuova nota">+ Nota</button>
            <span class="rx-sep"></span>
            <button type="button" class="${BTN}" data-rx="cap" title="Capitolo">Capitolo</button>
            <button type="button" class="${BTN}" data-rx="sub" title="Sottocapitolo">Sottocapitolo</button>
            <button type="button" class="${BTN}" data-rx="cit" title="Citazione">Citazione</button>
            <button type="button" class="${BTN}" data-rx="eln" title="Elenco puntato">Elenco</button>
            <button type="button" class="${BTN}" data-rx="elo" title="Elenco numerato">Elenco 1.</button>
            <button type="button" class="${BTN}" data-rx="tab" title="Tabella">Tabella</button>
            <button type="button" class="${BTN}" data-rx="riq" title="Riquadro in evidenza">Riquadro</button>
            <button type="button" class="${BTN}" data-rx="img" title="Immagine">Immagine</button>
            <button type="button" class="${BTN}" data-rx="sep" title="Linea di separazione">Separatore</button>
            <button type="button" class="${BTN}" data-rx="biblio" title="Aggiunge un riferimento bibliografico">+ Riferimento</button>
          </div>
          <div class="rx-ed"><pre id="rx-hl" aria-hidden="true"></pre><textarea id="rx-ta" rows="24" spellcheck="false" aria-label="Testo del documento">${esc(sorgente)}</textarea></div>
          <details class="rx-guida">
            <summary>Guida alla scrittura</summary>
            <ul>
              <li><code># Titolo</code> capitolo · <code>## Titolo</code> sottocapitolo · riga vuota = nuovo capoverso</li>
              <li><code>&gt; citazione</code> e, sotto, <code>&gt;&gt; Fonte</code> · <code>- voce</code> o <code>1. voce</code> elenchi · <code>---</code> separatore</li>
              <li><code>{{tabella Didascalia</code> … righe <code>Voce | Valore</code> … <code>}}</code> (la prima riga è l'intestazione)</li>
              <li><code>{{riquadro Titolo</code> … testo … <code>}}</code> · <code>![didascalia](https://…)</code> immagine</li>
              <li>Note: <code>[^1]</code> nel testo e <code>[^1]: testo della nota</code> altrove (il pulsante «+ Nota» fa tutto) · bibliografia: <code>{{bibliografia</code> … <code>- riferimento</code> … <code>}}</code></li>
              <li>Nel testo: <code>&lt;b&gt;grassetto&lt;/b&gt;</code>, <code>&lt;i&gt;corsivo&lt;/i&gt;</code>, <code>&lt;a href="https://…"&gt;link&lt;/a&gt;</code></li>
            </ul>
          </details>
        </div>
      </div>

      <div class="redazione-azioni-form">
        <button type="button" class="redazione-btn redazione-btn--primario" data-azione="salva">Salva</button>
        <button type="button" class="redazione-btn redazione-btn--secondario" data-azione="annulla">Chiudi</button>
      </div>`;

    const area = ta();
    area.addEventListener("scroll", () => { const h = el("rx-hl"); h.scrollTop = area.scrollTop; h.scrollLeft = area.scrollLeft; });
    if (window.ResizeObserver) new ResizeObserver(evidenzia).observe(area);
    evidenzia();
    aggiornaAnteprima();
  }

  /* ---------- BOTTONI: scrivono nel testo ---------- */

  // Sostituisce [ini, fine) con "testo" mantenendo annulla (Ctrl+Z); poi seleziona da ini+a a ini+b.
  function scrivi(ini, fine, testo, a, b) {
    const t = ta();
    t.focus();
    t.setSelectionRange(ini, fine);
    if (!document.execCommand || !document.execCommand("insertText", false, testo)) {
      t.setRangeText(testo, ini, fine, "end");
      t.dispatchEvent(new Event("input", { bubbles: true }));
    }
    t.setSelectionRange(ini + a, ini + b);
  }

  // Imposta tutto il testo (per le operazioni che toccano più punti) e sposta il cursore.
  function imposta(valore, a, b) {
    const t = ta();
    t.value = valore;
    t.blur();
    t.focus();
    t.setSelectionRange(a, b === undefined ? a : b);
    t.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function inline(pre, post, segnaposto) {
    const t = ta(), s = t.selectionStart, e = t.selectionEnd, sel = t.value.slice(s, e) || segnaposto;
    scrivi(s, e, pre + sel + post, pre.length, pre.length + sel.length);
  }

  // Inserisce un blocco su righe proprie (con righe vuote prima e dopo). fnRiga: prefisso per ogni riga della selezione.
  function blocco(pre, segnaposto, post, fnRiga) {
    const t = ta(), v = t.value, s = t.selectionStart, e = t.selectionEnd;
    let sel = v.slice(s, e).trim() || segnaposto;
    if (fnRiga) { sel = sel.split("\n").map((l, i) => fnRiga(i) + l).join("\n"); pre = ""; }
    const prima = v.slice(0, s), dopo = v.slice(e);
    const p = !prima ? "" : prima.endsWith("\n\n") ? "" : prima.endsWith("\n") ? "\n" : "\n\n";
    const q = !dopo.trim() ? "\n" : dopo.startsWith("\n\n") ? "" : dopo.startsWith("\n") ? "\n" : "\n\n";
    scrivi(s, e, p + pre + sel + post + q, p.length + pre.length, p.length + pre.length + (fnRiga ? sel.length : sel.length));
  }

  function offsetRighe(L) { const off = []; let o = 0; L.forEach(l => { off.push(o); o += l.length + 1; }); return off; }

  function linkAlCursore() {
    const t = ta();
    const url = prompt("Indirizzo del collegamento (https://… oppure #ancora):", "https://");
    if (!url || !url.trim() || url.trim() === "https://") return;
    const s = t.selectionStart, e = t.selectionEnd;
    const sel = t.value.slice(s, e) || prompt("Testo da mostrare:", url.trim());
    if (!sel) return;
    const pre = `<a href="${url.trim().replace(/"/g, "&quot;")}">`;
    scrivi(s, e, pre + sel + "</a>", pre.length, pre.length + sel.length);
  }

  function immagineAlCursore() {
    const url = prompt("Indirizzo dell'immagine (https://…):", "https://");
    if (!url || !url.trim() || url.trim() === "https://") return;
    const did = (prompt("Didascalia (facoltativa):", "") || "").replace(/[\[\]]/g, " ").trim();
    blocco("", `![${did}](${url.trim()})`, "");
  }

  // Inserisce [^n] al cursore e prepara la definizione "[^n]: " (dopo le altre note, o prima della bibliografia, o in fondo).
  function aggiungiNota() {
    const t = ta(), v = t.value, s = t.selectionStart, e = t.selectionEnd;
    const nums = [...v.matchAll(/\[\^(\d+)\]/g)].map(x => +x[1]);
    const n = (nums.length ? Math.max(...nums) : 0) + 1;
    let w = v.slice(0, s) + `[^${n}]` + v.slice(e);
    const L = w.split("\n"), off = offsetRighe(L), def = `[^${n}]: `;
    let ult = -1;
    L.forEach((l, i) => { if (/^\s*\[\^\d+\]:/.test(l)) ult = i; });
    let pos, ins;
    if (ult >= 0) { pos = off[ult] + L[ult].length; ins = "\n" + def; }
    else {
      const ib = L.findIndex(l => /^\{\{\s*bibliografia\b/i.test(l.trim()));
      if (ib >= 0) { pos = off[ib]; ins = def + "\n\n"; }
      else { pos = w.length; ins = (w.endsWith("\n") ? "" : "\n") + "\n" + def; }
    }
    w = w.slice(0, pos) + ins + w.slice(pos);
    imposta(w, pos + ins.indexOf(def) + def.length);
  }

  function aggiungiRiferimento() {
    const t = ta(), v = t.value, L = v.split("\n"), off = offsetRighe(L), ph = "Nuovo riferimento";
    const ib = L.findIndex(l => /^\{\{\s*bibliografia\b/i.test(l.trim()) && !/\}\}\s*$/.test(l.trim()));
    let j = -1;
    if (ib >= 0) for (let k = ib + 1; k < L.length; k++) if (L[k].trim() === "}}") { j = k; break; }
    if (j >= 0) {
      const ins = "- " + ph + "\n";
      imposta(v.slice(0, off[j]) + ins + v.slice(off[j]), off[j] + 2, off[j] + 2 + ph.length);
    } else {
      const pre = v.trim() ? (v.endsWith("\n") ? "\n" : "\n\n") : "";
      const ins = pre + "{{bibliografia\n- " + ph + "\n}}\n", a = v.length + pre.length + "{{bibliografia\n- ".length;
      imposta(v + ins, a, a + ph.length);
    }
  }

  function azioneStrumento(k) {
    switch (k) {
      case "b": inline("<b>", "</b>", "grassetto"); break;
      case "i": inline("<i>", "</i>", "corsivo"); break;
      case "link": linkAlCursore(); break;
      case "nota": aggiungiNota(); break;
      case "cap": blocco("# ", "Titolo del capitolo", ""); break;
      case "sub": blocco("## ", "Titolo del sottocapitolo", ""); break;
      case "cit": { const t = ta(); if (/\n/.test(t.value.slice(t.selectionStart, t.selectionEnd).trim())) blocco("", "", "", () => "> "); else blocco("> ", "Testo della citazione", "\n>> Fonte (autore, opera, anno)"); break; }
      case "eln": { const t = ta(); if (/\n/.test(t.value.slice(t.selectionStart, t.selectionEnd).trim())) blocco("", "", "", () => "- "); else blocco("- ", "prima voce", "\n- seconda voce"); break; }
      case "elo": { const t = ta(); if (/\n/.test(t.value.slice(t.selectionStart, t.selectionEnd).trim())) blocco("", "", "", i => (i + 1) + ". "); else blocco("1. ", "prima voce", "\n2. seconda voce"); break; }
      case "tab": blocco("{{tabella Didascalia\nVoce | Valore | Note\n", "Entrate | 1200 | confermate", "\n}}"); break;
      case "riq": blocco("{{riquadro Titolo\n", "Testo in evidenza", "\n}}"); break;
      case "img": immagineAlCursore(); break;
      case "sep": blocco("---", "", ""); break;
      case "biblio": aggiungiRiferimento(); break;
    }
  }

  /* ---------- VALIDAZIONE E SALVATAGGIO ---------- */

  function costruisciTesto() {
    const t = corrente;
    const id = (t.id || "").trim();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new Error("L'identificativo deve contenere solo lettere minuscole, numeri e trattini.");
    if (!(t.titolo || "").trim()) throw new Error("Il titolo è obbligatorio.");
    if (!(t.categoria || "").trim()) throw new Error("La categoria è obbligatoria.");

    const p = leggiSorgente(ta().value, true);

    // ogni richiamo [^n] deve avere la sua nota
    const pezzi = [t.abstract];
    p.corpo.forEach(b => { if (typeof b.testo === "string") pezzi.push(b.testo); });
    pezzi.join("\n").replace(/\[\^(\d+)\]/g, (m, n) => {
      if (+n > p.note.length || +n < 1) throw new Error(`Il richiamo [^${n}] non ha una nota: aggiungi «[^${n}]: testo» oppure toglilo.`);
      return m;
    });

    return {
      id, titolo: t.titolo.trim(), riferimento: (t.riferimento || "").trim(), sottotitolo: (t.sottotitolo || "").trim(), autore: (t.autore || "").trim(),
      categoria: t.categoria.trim(), stato: STATI.includes(t.stato) ? t.stato : "Bozza", data: t.data || "",
      abstract: (t.abstract || "").trim(), parole_chiave: (t.parole_chiave || []).filter(Boolean),
      copertina: (t.copertina || "").trim(), corpo: p.corpo, note: p.note, bibliografia: p.bibliografia
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

  /* ---------- EVENTI ---------- */

  function apri(testo, isNuovo) {
    const copia = JSON.parse(JSON.stringify(testo));
    copia.note = Array.isArray(copia.note) ? copia.note : [];
    copia.bibliografia = Array.isArray(copia.bibliografia) ? copia.bibliografia : [];
    copia.corpo = Array.isArray(copia.corpo) ? copia.corpo : [];
    corrente = copia;
    nuovo = isNuovo;
    sporco = false;
    idManuale = false;
    renderEditor(sorgenteDa(copia));
    window.scrollTo({ top: 0 });
  }

  function chiudiEditor() {
    if (sporco && !confirm("Ci sono modifiche non salvate. Chiudere comunque?")) return;
    renderMenu();
  }

  function initEventi() {
    const r = root();

    r.addEventListener("click", e => {
      const s = e.target.closest("[data-rx]");
      if (s && corrente) { azioneStrumento(s.dataset.rx); return; }
      const b = e.target.closest("[data-azione]");
      if (!b || b.disabled) return;
      switch (b.dataset.azione) {
        case "nuovo-testo": apri(vuoto(), true); break;
        case "modifica": { const t = testi.find(x => x.id === b.dataset.id); if (t) apri(t, false); break; }
        case "elimina-testo": eliminaTesto(b.dataset.id); break;
        case "annulla": chiudiEditor(); break;
        case "salva": salva(b); break;
      }
    });

    // i bottoni non tolgono il fuoco (e la selezione) alla casella di testo
    r.addEventListener("mousedown", e => { if (e.target.closest("[data-rx]")) e.preventDefault(); });

    r.addEventListener("input", e => {
      const f = e.target;
      if (!corrente) return;
      if (f.id === "rx-ta") { evidenzia(); rinviaAnteprima(); sporco = true; return; }
      if (f.dataset.meta) {
        const k = f.dataset.meta;
        if (k === "parole_chiave") corrente.parole_chiave = f.value.split(/[,;]/).map(s => s.trim()).filter(Boolean);
        else corrente[k] = f.value;
        if (k === "id") idManuale = true;
        if (k === "titolo" && nuovo && !idManuale) {
          corrente.id = U.slugify(f.value);
          el("m-id").value = corrente.id;
        }
        if (k === "titolo" || k === "sottotitolo" || k === "abstract") rinviaAnteprima();
        sporco = true;
      }
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
