// assets/js/rapporti-core.js
// Libreria comune di Rapporti, caricata da index.html e redazione.html:
//   - configurazione, icona della scheda, testata e piè di pagina;
//   - utilità (escape, URL sicuri, date, tempo di lettura, pulizia dell'HTML);
//   - rendering di un testo saggistico (indice, corpo, note, bibliografia): è lo STESSO
//     codice per la pagina pubblica e per l'anteprima della redazione;
//   - client dell'endpoint /api/rapporti (lettura, login, salvataggio).
//
// STRUTTURA DI UN TESTO (salvata in rapporti.json, campo "testi"):
//   {
//     id, titolo, sottotitolo, autore, categoria,
//     riferimento,                       // numero di rapporto / protocollo (facoltativo)
//     stato: "Bozza" | "Pubblicato",     // le bozze le vede solo la redazione
//     data: "2026-10-06",                // AAAA-MM-GG
//     abstract, parole_chiave: [..], copertina,
//     corpo: [ blocco, ... ],
//     note: [ { testo } ],               // richiamate nel testo con [^1], [^2]...
//     bibliografia: [ { testo } ]
//   }
//   blocco = { tipo: "capitolo",       titolo }
//          | { tipo: "sottocapitolo",  titolo }
//          | { tipo: "paragrafo",      testo }            // righe vuote = nuovi capoversi
//          | { tipo: "citazione",      testo, fonte }
//          | { tipo: "immagine",       url, didascalia }
//          | { tipo: "elenco",         testo, ordinato }   // una voce per riga; ordinato = true -> numerato
//          | { tipo: "tabella",        testo, didascalia } // una riga per riga, celle separate da |; la prima riga è l'intestazione
//          | { tipo: "riquadro",       titolo, testo }     // box di evidenza (avvertenze, sintesi, decisioni)
//          | { tipo: "separatore" }
// I numeri dei capitoli (1, 1.1, 2...) NON sono salvati: si ricalcolano dall'ordine.

const SITE_CONFIG_RAPPORTI = {
  nome: "FGCI",
  motto: "Sezione di Forlì",
  annoFondazione: 2026,
  emblema: "fgci.png",
  icona: "fgci.png",
  categorie: ["Rapporto", "Articolo", "Relazione", "Verbale", "Comunicato", "Saggio", "Appunti"],
  endpoint: "/api/rapporti"
};

const Rapporti = (function () {
  /* ---------- UTILITÀ ---------- */

  const escAttr = t => (t == null ? "" : t).toString().replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function urlSicuro(valore) {
    const u = (valore || "").toString().trim();
    if (!u) return "";
    if (/^(https?:)?\/\//i.test(u) || /^mailto:/i.test(u) || u.charAt(0) === "#") return u;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return "";
    return u;
  }

  const slugify = t => (t || "").toString().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

  function formattaData(valore) {
    const v = (valore || "").toString().trim();
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return v;
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" });
  }

  // Toglie i tag da un frammento di HTML e restituisce solo il testo.
  function soloTesto(html) {
    const doc = new DOMParser().parseFromString("<body>" + String(html == null ? "" : html) + "</body>", "text/html");
    return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
  }

  // Pulizia dell'HTML scritto in redazione: restano solo grassetto, corsivo, link e poco altro.
  // Gli a-capo semplici diventano <br>. Tutto il resto (script, stili, attributi) viene tolto.
  const TAG_AMMESSI = new Set(["A", "B", "STRONG", "I", "EM", "U", "S", "BR", "SUP", "SUB", "MARK", "SMALL", "CODE"]);
  const TAG_SCARTATI = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "NOSCRIPT", "TEMPLATE", "LINK", "META"]);

  function pulisciHtml(testo) {
    const grezzo = String(testo == null ? "" : testo).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>");
    const doc = new DOMParser().parseFromString("<body>" + grezzo + "</body>", "text/html");
    const visita = nodo => {
      Array.from(nodo.childNodes).forEach(f => {
        if (f.nodeType === 3) return;
        if (f.nodeType !== 1) { f.remove(); return; }
        const t = f.tagName;
        if (TAG_SCARTATI.has(t)) { f.remove(); return; }
        visita(f);
        if (!TAG_AMMESSI.has(t)) { f.replaceWith(...Array.from(f.childNodes)); return; }
        const href = t === "A" ? f.getAttribute("href") : null;
        Array.from(f.attributes).forEach(a => f.removeAttribute(a.name));
        if (t === "A") {
          const u = urlSicuro(href);
          if (!u) { f.replaceWith(...Array.from(f.childNodes)); return; }
          f.setAttribute("href", u);
          if (u.charAt(0) !== "#") { f.setAttribute("target", "_blank"); f.setAttribute("rel", "noopener noreferrer"); }
        }
      });
    };
    visita(doc.body);
    return doc.body.innerHTML;
  }

  function contaParole(t) {
    const pezzi = [t.abstract];
    (Array.isArray(t.corpo) ? t.corpo : []).forEach(b => {
      if (b && ["paragrafo", "citazione", "elenco", "riquadro", "tabella"].includes(b.tipo)) pezzi.push(String(b.testo || "").replace(/\|/g, " "));
    });
    return pezzi.map(soloTesto).join(" ").split(/\s+/).filter(Boolean).length;
  }

  const tempoLettura = t => Math.max(1, Math.round(contaParole(t) / 200));

  /* ---------- ICONA, TESTATA, PIÈ DI PAGINA ---------- */

  function impostaIcona() {
    if (!document.head) return;
    const href = (SITE_CONFIG_RAPPORTI.icona || "fgci.png") + "?v=1";
    document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]').forEach(l => l.remove());
    [["icon", "image/png"], ["shortcut icon", "image/png"], ["apple-touch-icon", ""]].forEach(([rel, type]) => {
      const l = document.createElement("link");
      l.rel = rel;
      if (type) l.type = type;
      l.href = href;
      document.head.appendChild(l);
    });
  }

  function renderTestata(paginaAttiva) {
    const el = document.getElementById("testata-root");
    if (!el) return;
    const C = SITE_CONFIG_RAPPORTI;
    const voci = C.categorie.map(c =>
      `<li><a href="index.html?categoria=${encodeURIComponent(c)}" class="${paginaAttiva === c ? "attiva" : ""}">${escAttr(c)}</a></li>`).join("");
    el.innerHTML = `
      <header class="testata">
        <div class="container testata__riga">
          <div class="testata__emblema" aria-hidden="true">
            <img src="${escAttr(C.emblema)}" alt="" onerror="this.parentNode.style.display='none'">
          </div>
          <div class="testata__testi">
            <h2 class="testata__nome"><a href="index.html">${escAttr(C.nome)}</a></h2>
            <p class="testata__motto">${escAttr(C.motto)}</p>
          </div>
        </div>
      </header>
      <div class="fascia-tricolore" role="presentation"><span class="banda-1"></span><span class="banda-2"></span><span class="banda-3"></span></div>
      <nav class="nav-principale" aria-label="Navigazione principale">
        <div class="container">
          <ul>
            <li><a href="index.html" class="${paginaAttiva === "home" ? "attiva" : ""}">Tutti i testi</a></li>
            ${voci}
          </ul>
        </div>
      </nav>`;
  }

  function renderFooter() {
    const el = document.getElementById("footer-root");
    if (!el) return;
    const C = SITE_CONFIG_RAPPORTI;
    el.innerHTML = `
      <div class="fascia-rossa" role="presentation"></div>
      <footer>
        <div class="container footer__contenuto">
          <span>&copy; ${C.annoFondazione}&ndash;${new Date().getFullYear()} ${escAttr(C.nome)}. </span>
        </div>
      </footer>`;
  }

  /* ---------- LETTURA DELLA STRUTTURA ---------- */

  // Blocchi del corpo con numerazione e ancore già calcolate (capitolo = N, sottocapitolo = N.M).
  function leggiCorpo(t) {
    let c = 0, s = 0;
    return (Array.isArray(t.corpo) ? t.corpo : []).map(b => {
      if (!b || typeof b !== "object") return null;
      if (b.tipo === "capitolo") { c++; s = 0; return Object.assign({}, b, { num: String(c), ancora: "cap-" + c }); }
      if (b.tipo === "sottocapitolo") { s++; return Object.assign({}, b, { num: c ? c + "." + s : String(s), ancora: "cap-" + c + "-" + s }); }
      return b;
    }).filter(Boolean);
  }

  const noteDi = t => (Array.isArray(t.note) ? t.note : []).filter(n => n && typeof n === "object");
  const biblioDi = t => (Array.isArray(t.bibliografia) ? t.bibliografia : []).filter(b => b && typeof b === "object" && (b.testo || "").toString().trim());

  /* ---------- HTML DEL TESTO ---------- */

  // Testo di un blocco: pulito, con i richiami [^n] trasformati in numeri in apice che portano alla nota.
  function htmlRichiami(testo, note, usati) {
    return pulisciHtml(testo).replace(/\[\^(\d+)\]/g, (m, n) => {
      const nota = note[+n - 1];
      if (!nota) return m;
      const id = usati.has(n) ? "" : ` id="rif-nota-${n}"`;
      usati.add(n);
      return `<sup class="ut-richiamo"><a href="#nota-${n}"${id} aria-label="Nota ${n}">${n}</a></sup>`;
    });
  }

  function htmlParagrafi(testo, note, usati) {
    return String(testo == null ? "" : testo).replace(/\r\n?/g, "\n").split(/\n{2,}/)
      .map(p => p.trim()).filter(Boolean)
      .map(p => `<p>${htmlRichiami(p, note, usati)}</p>`).join("");
  }

  function htmlImmagine(b, titolo) {
    const src = urlSicuro(b.url);
    if (!src) return "";
    const did = (b.didascalia || "").toString().trim();
    return `<figure class="ut-figura"><img src="${escAttr(src)}" alt="${escAttr(did || titolo)}" loading="lazy" onerror="this.closest('figure').style.display='none'">${did ? `<figcaption>${escAttr(did)}</figcaption>` : ""}</figure>`;
  }

  const righeElenco = b => String(b.testo == null ? "" : b.testo).replace(/\r\n?/g, "\n").split("\n").map(r => r.trim()).filter(Boolean);
  const righeTabella = b => righeElenco(b).map(r => r.split("|").map(c => c.trim()));

  function htmlElenco(b, note, usati) {
    const voci = righeElenco(b);
    if (!voci.length) return "";
    const tag = b.ordinato ? "ol" : "ul";
    return `<${tag} class="ut-lista">${voci.map(v => `<li>${htmlRichiami(v, note, usati)}</li>`).join("")}</${tag}>`;
  }

  function htmlTabella(b, note, usati) {
    const righe = righeTabella(b);
    if (!righe.length) return "";
    const n = Math.max(...righe.map(r => r.length));
    const riga = (r, tag) => `<tr>${Array.from({ length: n }, (_, i) => `<${tag}>${htmlRichiami(r[i] || "", note, usati)}</${tag}>`).join("")}</tr>`;
    const did = (b.didascalia || "").toString().trim();
    return `<figure class="ut-tabella"><div class="ut-tabella__scroll"><table><thead>${riga(righe[0], "th")}</thead><tbody>${righe.slice(1).map(r => riga(r, "td")).join("")}</tbody></table></div>${did ? `<figcaption>${escAttr(did)}</figcaption>` : ""}</figure>`;
  }

  function htmlRiquadro(b, note, usati) {
    const tit = (b.titolo || "").toString().trim();
    return `<aside class="ut-riquadro">${tit ? `<h4>${escAttr(tit)}</h4>` : ""}${htmlParagrafi(b.testo, note, usati)}</aside>`;
  }

  function htmlCorpo(t) {
    const note = noteDi(t);
    const usati = new Set();
    return leggiCorpo(t).map(b => {
      switch (b.tipo) {
        case "capitolo":
          return `<h2 class="ut-cap" id="${b.ancora}"><span class="ut-cap__num">${b.num}</span>${escAttr(b.titolo)}</h2>`;
        case "sottocapitolo":
          return `<h3 class="ut-sub" id="${b.ancora}"><span class="ut-sub__num">${b.num}</span>${escAttr(b.titolo)}</h3>`;
        case "citazione": {
          const fonte = (b.fonte || "").toString().trim();
          return `<blockquote class="ut-citazione">${htmlParagrafi(b.testo, note, usati)}${fonte ? `<footer>${escAttr(fonte)}</footer>` : ""}</blockquote>`;
        }
        case "immagine":
          return htmlImmagine(b, t.titolo);
        case "elenco":
          return htmlElenco(b, note, usati);
        case "tabella":
          return htmlTabella(b, note, usati);
        case "riquadro":
          return htmlRiquadro(b, note, usati);
        case "separatore":
          return `<hr class="ut-separatore">`;
        default:
          return htmlParagrafi(b.testo, note, usati);
      }
    }).join("");
  }

  function htmlNote(t) {
    const note = noteDi(t);
    if (!note.length) return "";
    const voci = note.map((n, i) =>
      `<li id="nota-${i + 1}">${pulisciHtml(n.testo)} <a class="ut-ritorno" href="#rif-nota-${i + 1}" aria-label="Torna al testo">&#8617;</a></li>`).join("");
    return `<section class="ut-note" id="note-testo"><h2 class="ut-sezione-fine">Note</h2><ol>${voci}</ol></section>`;
  }

  function htmlBibliografia(t) {
    const voci = biblioDi(t);
    if (!voci.length) return "";
    return `<section class="ut-biblio" id="bibliografia-testo"><h2 class="ut-sezione-fine">Bibliografia</h2><ul>${voci.map(b => `<li>${pulisciHtml(b.testo)}</li>`).join("")}</ul></section>`;
  }

  function htmlIndice(t) {
    const righe = leggiCorpo(t).filter(b => b.tipo === "capitolo" || b.tipo === "sottocapitolo").map(b =>
      `<li class="${b.tipo === "sottocapitolo" ? "ut-indice__sub" : "ut-indice__cap"}"><a href="#${b.ancora}"><span>${b.num}</span> ${escAttr(b.titolo)}</a></li>`);
    if (noteDi(t).length) righe.push(`<li class="ut-indice__cap ut-indice__fine"><a href="#note-testo">Note</a></li>`);
    if (biblioDi(t).length) righe.push(`<li class="ut-indice__cap ut-indice__fine"><a href="#bibliografia-testo">Bibliografia</a></li>`);
    if (righe.length < 2) return "";
    return `<nav class="ut-indice" aria-label="Indice del testo"><h2>Indice</h2><ol>${righe.join("")}</ol></nav>`;
  }

  /* ---------- CLIENT API ---------- */

  const CHIAVE_SESSIONE = "rapporti_sessione";

  const API = {
    _sessione: { token: null, username: null },

    setSessione(token, username) {
      this._sessione = { token, username };
      try { sessionStorage.setItem(CHIAVE_SESSIONE, JSON.stringify(this._sessione)); } catch (e) {}
    },
    loadCredentials() {
      try {
        const raw = sessionStorage.getItem(CHIAVE_SESSIONE);
        if (raw) this._sessione = JSON.parse(raw);
      } catch (e) {}
      return this._sessione;
    },
    clearCredentials() {
      this._sessione = { token: null, username: null };
      try { sessionStorage.removeItem(CHIAVE_SESSIONE); } catch (e) {}
    },
    isAuthenticated() { return !!this._sessione.token; },

    // Pagina pubblica: solo i testi "Pubblicato". Redazione (tutti = true): anche le bozze,
    // riconosciute dal token; se il token è scaduto l'endpoint risponde 401 (mai una lista parziale).
    async loadTesti(tutti) {
      const headers = {};
      if (tutti) {
        if (!this.isAuthenticated()) throw new Error("Non autenticato: effettua il login.");
        headers.Authorization = "Bearer " + this._sessione.token;
      }
      const res = await fetch(SITE_CONFIG_RAPPORTI.endpoint, { headers, cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const e = new Error(data.error ? `HTTP ${res.status}: ${data.error}` : `HTTP ${res.status}`);
        e.status = res.status;
        throw e;
      }
      return Array.isArray(data.testi) ? data.testi : [];
    },

    async saveTesti(lista) {
      if (!this.isAuthenticated()) throw new Error("Non autenticato: effettua il login.");
      const res = await fetch(SITE_CONFIG_RAPPORTI.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + this._sessione.token },
        body: JSON.stringify({ azione: "salva", testi: lista })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const e = new Error(data.error || `HTTP ${res.status}`);
        e.status = res.status;
        throw e;
      }
      return true;
    },

    async login(username, password) {
      const res = await fetch(SITE_CONFIG_RAPPORTI.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ azione: "login", username, password })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || "Credenziali errate");
      this.setSessione(data.token, username);
      return data;
    }
  };

  API.loadCredentials();
  impostaIcona();

  return {
    escAttr, urlSicuro, slugify, formattaData, soloTesto, pulisciHtml, contaParole, tempoLettura,
    renderTestata, renderFooter, leggiCorpo, noteDi, biblioDi, righeElenco, righeTabella,
    htmlCorpo, htmlNote, htmlBibliografia, htmlIndice, htmlRichiami,
    API
  };
})();
