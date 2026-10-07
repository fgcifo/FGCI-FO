// assets/js/rapporti.js — pagina pubblica di Rapporti (index.html).
//   index.html            -> elenco dei testi pubblicati, con ricerca e filtri
//   index.html?id=<id>    -> lettura di un testo
// Ancore del testo: #cap-N, #cap-N-M, #nota-N, #note-testo, #bibliografia-testo.
(function () {
  const U = Rapporti;
  const esc = U.escAttr;
  const parametri = new URLSearchParams(window.location.search);
  const root = () => document.getElementById("rapporti-root");

  /* =====================  ELENCO  ===================== */

  let testi = [];
  let categoriaAttiva = parametri.get("categoria") || "Tutti";
  let testoRicerca = "";

  const categorieDisponibili = () => ["Tutti", ...new Set(testi.map(t => t.categoria).filter(Boolean))];

  function filtrati() {
    const q = testoRicerca.trim().toLowerCase();
    return testi
      .filter(t => {
        const okCat = categoriaAttiva === "Tutti" || t.categoria === categoriaAttiva;
        const pezzi = [t.titolo, t.sottotitolo, t.autore, t.abstract, (t.parole_chiave || []).join(" ")];
        const okTxt = !q || pezzi.some(p => (p || "").toString().toLowerCase().includes(q));
        return okCat && okTxt;
      })
      .sort((a, b) => (b.data || "").localeCompare(a.data || ""));
  }

  function schedaTesto(t) {
    const meta = [t.autore, U.formattaData(t.data), U.tempoLettura(t) + " min di lettura"].filter(Boolean).map(esc).join(" &middot; ");
    const copertina = U.urlSicuro(t.copertina);
    return `
      <a class="ut-scheda" href="index.html?id=${encodeURIComponent(t.id)}">
        <div class="ut-scheda__testo">
          <span class="badge-categoria">${esc(t.categoria)}</span>
          <h3 class="ut-scheda__titolo">${esc(t.titolo)}</h3>
          ${t.sottotitolo ? `<p class="ut-scheda__sottotitolo">${esc(t.sottotitolo)}</p>` : ""}
          ${t.abstract ? `<p class="ut-scheda__abstract">${esc(U.soloTesto(t.abstract))}</p>` : ""}
          <p class="ut-scheda__meta">${meta}</p>
        </div>
        ${copertina ? `<img class="ut-scheda__immagine" src="${esc(copertina)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ""}
      </a>`;
  }

  function renderFiltri() {
    const el = document.getElementById("filtri-root");
    if (!el) return;
    el.innerHTML = categorieDisponibili().map(c =>
      `<button type="button" class="filtro ${c === categoriaAttiva ? "attivo" : ""}" data-valore="${esc(c)}">${esc(c)}</button>`).join("");
    el.querySelectorAll(".filtro").forEach(btn => btn.addEventListener("click", () => {
      categoriaAttiva = btn.dataset.valore;
      renderFiltri();
      renderElenco();
    }));
  }

  function renderElenco() {
    const r = filtrati();
    document.getElementById("conteggio-risultati").textContent =
      r.length === testi.length ? `${testi.length} documenti pubblicati` : `${r.length} risultati su ${testi.length} documenti`;
    document.getElementById("elenco-root").innerHTML = r.length
      ? r.map(schedaTesto).join("")
      : `<div class="nessun-risultato">Nessun documento corrisponde alla ricerca effettuata.</div>`;
  }

  async function mostraElenco() {
    U.renderTestata(categoriaAttiva === "Tutti" ? "home" : categoriaAttiva);
    root().innerHTML = `
      <section class="hero hero--elenco">
        <span class="hero__kicker">Archivio della redazione</span>
        <h1 class="hero__titolo">Rapporti, articoli e testi</h1>
        <p class="hero__sottotitolo"></p>
        <form id="form-ricerca" class="ricerca" role="search">
          <label for="campo-ricerca" class="solo-lettori">Cerca nei testi</label>
          <input id="campo-ricerca" type="text" placeholder="Cerca per titolo, autore o parola chiave&hellip;" autocomplete="off" />
          <button type="submit">Cerca</button>
        </form>
      </section>
      <h2 class="sezione-titolo">Elenco dei documenti</h2>
      <div id="filtri-root" class="filtri"></div>
      <p id="conteggio-risultati" class="conteggio"></p>
      <div id="elenco-root" class="ut-elenco"></div>`;

    try {
      testi = await U.API.loadTesti(false);
    } catch (e) {
      console.error(e);
      document.getElementById("elenco-root").innerHTML =
        `<div class="nessun-risultato">Errore nel caricamento dei testi (${esc(e.message || "errore sconosciuto")}).</div>`;
      return;
    }

    renderFiltri();
    renderElenco();
    const input = document.getElementById("campo-ricerca");
    document.getElementById("form-ricerca").addEventListener("submit", e => {
      e.preventDefault();
      testoRicerca = input.value;
      renderElenco();
    });
    input.addEventListener("input", () => { testoRicerca = input.value; renderElenco(); });
  }

  /* =====================  LETTURA  ===================== */

  // Segna nell'indice il capitolo che si sta leggendo.
  function evidenziaIndice() {
    const link = new Map();
    document.querySelectorAll(".ut-indice a").forEach(a => link.set(a.getAttribute("href").slice(1), a));
    const titoli = Array.from(document.querySelectorAll(".ut-cap, .ut-sub, #note-testo, #bibliografia-testo")).filter(el => link.has(el.id));
    if (!titoli.length || !("IntersectionObserver" in window)) return;
    const obs = new IntersectionObserver(voci => {
      voci.forEach(v => {
        if (!v.isIntersecting) return;
        link.forEach(a => a.classList.remove("corrente"));
        const a = link.get(v.target.id);
        if (a) a.classList.add("corrente");
      });
    }, { rootMargin: "-80px 0px -70% 0px" });
    titoli.forEach(t => obs.observe(t));
  }

  /* ---------- PDF (motore comune assets/js/pdf-export.js) ---------- */

  // Logo mostrato nella barra blu di ogni pagina del PDF (percorso relativo a index.html).
  const LOGO_UNITA = "fgci.png";

  function caricaPdfExport() {
    if (window.PdfExport) return Promise.resolve(window.PdfExport);
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "assets/js/pdf-export.js";
      s.onload = () => window.PdfExport ? resolve(window.PdfExport) : reject(new Error("Modulo PDF non valido"));
      s.onerror = () => reject(new Error("File assets/js/pdf-export.js non trovato"));
      document.head.appendChild(s);
    });
  }

  async function scaricaPdf(t) {
    const PE = await caricaPdfExport();
    const C = PE.colori;
    const pdf = await PE.crea({ marca: { nome: SITE_CONFIG_RAPPORTI.nome, sottotitolo: SITE_CONFIG_RAPPORTI.motto, logo: LOGO_UNITA } });
    const note = U.noteDi(t);
    const conRichiami = s => (s || "").toString().replace(/\[\^(\d+)\]/g, (m, n) => (note[+n - 1] ? "[" + n + "]" : m));

    pdf.scrivi((t.categoria || "").toString().toUpperCase(), { font: "helvetica", stile: "bold", size: 9, colore: C.rosso, dopo: 3 });
    pdf.scrivi(t.titolo, { font: "helvetica", stile: "bold", size: 21, colore: C.scuro, dopo: 2, interlinea: 1.25 });
    if (t.sottotitolo) pdf.scrivi(t.sottotitolo, { font: "helvetica", size: 13, colore: C.tenue, dopo: 3 });
    pdf.linea();
    pdf.dati([
      ["Autore", t.autore || "—"],
      ["Riferimento", t.riferimento || "—"],
      ["Data", U.formattaData(t.data) || "—"],
      ["Lettura", U.tempoLettura(t) + " min"],
      ["Parole chiave", (t.parole_chiave || []).join(", ") || "—"]
    ]);
    pdf.linea();
    pdf.spazio(3);
    if (t.abstract) { pdf.scrivi(t.abstract, { stile: "italic", colore: C.tenue, dopo: 4 }); }
    if (t.copertina) await pdf.immagine(t.copertina, "", { maxH: 60 });

    for (const b of U.leggiCorpo(t)) {
      if (b.tipo === "capitolo") {
        pdf.spazio(3);
        pdf.riservaSpazio(26);
        pdf.scrivi(`${b.num}. ${b.titolo}`, { font: "helvetica", stile: "bold", size: 14, colore: C.rosso, dopo: 2 });
      } else if (b.tipo === "sottocapitolo") {
        pdf.spazio(1);
        pdf.riservaSpazio(22);
        pdf.scrivi(`${b.num} ${b.titolo}`, { font: "helvetica", stile: "bold", size: 11.5, colore: C.scuro, dopo: 1.5 });
      } else if (b.tipo === "citazione") {
        String(b.testo || "").split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
          .forEach(p => pdf.scrivi(conRichiami(p), { x: 28, stile: "italic", dopo: 1 }));
        if ((b.fonte || "").trim()) pdf.scrivi("— " + b.fonte, { x: 28, font: "helvetica", size: 9, colore: C.tenue, dopo: 2.5 });
      } else if (b.tipo === "immagine") {
        await pdf.immagineDestra(b.url, b.didascalia);
      } else if (b.tipo === "elenco") {
        U.righeElenco(b).forEach((v, k) => pdf.scrivi((b.ordinato ? (k + 1) + ". " : "\u2022 ") + conRichiami(v), { x: 26, dopo: 0.8 }));
        pdf.spazio(1.5);
      } else if (b.tipo === "tabella") {
        const cella = (c, tag) => `<${tag}>${esc(U.soloTesto(conRichiami(c)))}</${tag}>`;
        const html = "<table>" + U.righeTabella(b).map((r, i) => "<tr>" + r.map(c => cella(c, i ? "td" : "th")).join("") + "</tr>").join("") + "</table>";
        pdf.scrivi(html, { size: 9, dopo: 1 });
        if ((b.didascalia || "").trim()) pdf.scrivi(b.didascalia, { font: "helvetica", stile: "italic", size: 8.5, colore: C.tenue, dopo: 3 });
      } else if (b.tipo === "riquadro") {
        pdf.riservaSpazio(24);
        pdf.linea(C.rosso, 0.8);
        if ((b.titolo || "").trim()) pdf.scrivi(b.titolo, { font: "helvetica", stile: "bold", size: 10.5, colore: C.rosso, x: 24, dopo: 1 });
        String(b.testo || "").split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
          .forEach(p => pdf.scrivi(conRichiami(p), { x: 24, size: 10.5, dopo: 1.5 }));
        pdf.linea(C.linea, 0.3);
      } else if (b.tipo === "separatore") {
        pdf.linea(C.linea, 0.3);
      } else {
        String(b.testo || "").split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
          .forEach(p => pdf.scrivi(conRichiami(p), { dopo: 2 }));
      }
    }

    if (note.length) {
      pdf.spazio(4); pdf.riservaSpazio(30);
      pdf.scrivi("Note", { font: "helvetica", stile: "bold", size: 13, colore: C.rosso, dopo: 2 });
      pdf.linea(C.linea, 0.3);
      note.forEach((n, i) => pdf.scrivi(`${i + 1}. ${n.testo || ""}`, { size: 10, dopo: 1 }));
    }
    const biblio = U.biblioDi(t);
    if (biblio.length) {
      pdf.spazio(4); pdf.riservaSpazio(30);
      pdf.scrivi("Bibliografia", { font: "helvetica", stile: "bold", size: 13, colore: C.rosso, dopo: 2 });
      pdf.linea(C.linea, 0.3);
      biblio.forEach(b => pdf.scrivi(b.testo, { size: 10, dopo: 1 }));
    }

    pdf.salva(PE.nomeFile(t.titolo, "testo"), t.titolo);
  }

  function collegaBottonePdf(t) {
    const btn = document.getElementById("btn-scarica-pdf");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const originale = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Generazione PDF…";
      try { await scaricaPdf(t); }
      catch (e) { alert("Errore nella creazione del PDF: " + e.message); }
      finally { btn.disabled = false; btn.textContent = originale; }
    });
  }

  async function mostraTesto(id) {
    let lista = [];
    try {
      lista = await U.API.loadTesti(false);
    } catch (e) {
      U.renderTestata("home");
      root().innerHTML = `<div class="nessun-risultato">Errore nel caricamento del testo.</div>`;
      return;
    }

    const t = lista.find(x => x.id === id);
    if (!t) {
      U.renderTestata("home");
      root().innerHTML = `
        <p class="breadcrumb"><a href="index.html">Home</a> &rsaquo; Testo non trovato</p>
        <div class="nessun-risultato">Il testo richiesto non è stato trovato. Torna alla <a href="index.html">home</a>.</div>`;
      document.title = "Testo non trovato — " + SITE_CONFIG_RAPPORTI.nome;
      return;
    }

    U.renderTestata(t.categoria);
    document.title = t.titolo + " — " + SITE_CONFIG_RAPPORTI.nome;

    const indice = U.htmlIndice(t);
    const parole = (t.parole_chiave || []).filter(Boolean).map(p => `<li>${esc(p)}</li>`).join("");
    const copertina = U.urlSicuro(t.copertina);

    root().innerHTML = `
      <p class="breadcrumb">
        <a href="index.html">Home</a> &rsaquo;
        <a href="index.html?categoria=${encodeURIComponent(t.categoria || "")}">${esc(t.categoria)}</a> &rsaquo;
        ${esc(t.titolo)}
      </p>
      <header class="ut-testata-testo">
        <span class="badge-categoria">${esc(t.categoria)}</span>
        <h1>${esc(t.titolo)}</h1>
        ${t.sottotitolo ? `<p class="ut-testata-testo__sottotitolo">${esc(t.sottotitolo)}</p>` : ""}
        <p class="ut-testata-testo__meta">
          ${t.autore ? `<span>di <b>${esc(t.autore)}</b></span>` : ""}
          ${t.riferimento ? `<span>Rif. <b>${esc(t.riferimento)}</b></span>` : ""}
          ${t.data ? `<span>${esc(U.formattaData(t.data))}</span>` : ""}
          <span>${U.tempoLettura(t)} min di lettura</span>
        </p>
        ${t.abstract ? `<div class="ut-abstract"><h2>In breve</h2><p>${U.pulisciHtml(t.abstract)}</p></div>` : ""}
        ${parole ? `<ul class="ut-parole">${parole}</ul>` : ""}
        <div class="ut-azioni">
          <button type="button" id="btn-scarica-pdf" class="ut-btn">Scarica in PDF</button>
          <button type="button" id="btn-stampa" class="ut-btn ut-btn--secondario">Stampa</button>
        </div>
      </header>
      <div class="ut-pagina ${indice ? "" : "ut-pagina--senza-indice"}">
        ${indice ? `<aside class="ut-colonna-indice">${indice}</aside>` : ""}
        <article class="ut-lettura">
          ${copertina ? `<figure class="ut-figura ut-figura--copertina"><img src="${esc(copertina)}" alt="${esc(t.titolo)}" onerror="this.closest('figure').style.display='none'"></figure>` : ""}
          ${U.htmlCorpo(t)}
          ${U.htmlNote(t)}
          ${U.htmlBibliografia(t)}
        </article>
      </div>`;

    collegaBottonePdf(t);
    document.getElementById("btn-stampa").addEventListener("click", () => window.print());
    evidenziaIndice();

    // il contenuto è creato dopo il caricamento: se l'indirizzo ha un'ancora, si riposiziona la vista
    if (location.hash) {
      const el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (el) el.scrollIntoView();
    }
  }

  /* =====================  AVVIO  ===================== */

  function init() {
    U.renderFooter();
    const id = parametri.get("id");
    if (id) mostraTesto(id); else mostraElenco();
  }

  document.addEventListener("DOMContentLoaded", init);
})();