// lib/github.js — accesso alla repo DATA tramite API GitHub.
//
// La scrittura usa le Git Data API (tree → commit → ref) invece di "PUT contents", così
// rapporti.json e chain.json finiscono nello STESSO commit: o si salvano entrambi o nessuno.
// L'aggiornamento del ref non è forzato: se qualcuno ha committato nel frattempo GitHub
// rifiuta (422) e l'errore diventa un 409 "riprova".
const REPO = () => process.env.GITHUB_REPO || "fgcifo/DATA";
const BRANCH = () => process.env.GITHUB_BRANCH || "main";
const TOKEN = () => process.env.GITHUB_TOKEN || "";

const intestazioni = extra => {
  const h = { Accept: "application/vnd.github+json", "User-Agent": "fgci-rapporti", "X-GitHub-Api-Version": "2022-11-28", ...extra };
  if (TOKEN()) h.Authorization = "Bearer " + TOKEN();
  return h;
};
const enc = p => p.split("/").map(encodeURIComponent).join("/");
const api = p => `https://api.github.com/repos/${REPO()}${p}`;

function errore(messaggio, stato) { const e = new Error(messaggio); e.status = stato; return e; }

// Commit corrente del branch.
async function leggiHead() {
  const r = await fetch(api(`/git/ref/heads/${enc(BRANCH())}`), { headers: intestazioni(), cache: "no-store" });
  if (!r.ok) throw errore(`GitHub ha risposto ${r.status} leggendo il branch ${BRANCH()} (controlla GITHUB_REPO, GITHUB_BRANCH e GITHUB_TOKEN)`, 500);
  return (await r.json()).object.sha;
}

// Testo di un file a un certo ref (branch o sha di commit); null se non esiste.
async function leggiFile(path, ref) {
  const r = await fetch(`${api(`/contents/${enc(path)}`)}?ref=${encodeURIComponent(ref || BRANCH())}`,
    { headers: intestazioni({ Accept: "application/vnd.github.raw+json" }), cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw errore(`GitHub ha risposto ${r.status} leggendo ${path} (controlla GITHUB_REPO, GITHUB_BRANCH e GITHUB_TOKEN)`, 500);
  return await r.text();
}

async function chiama(metodo, percorso, corpo, descrizione) {
  const r = await fetch(api(percorso), { method: metodo, headers: intestazioni({ "Content-Type": "application/json" }), body: JSON.stringify(corpo) });
  if (r.status === 409 || r.status === 422) {
    throw errore("L'archivio è stato modificato nel frattempo da un altro redattore: ricarica la pagina e riprova.", 409);
  }
  if (!r.ok) throw errore(`GitHub ha risposto ${r.status} in scrittura (${descrizione}; il GITHUB_TOKEN deve avere permesso Contents: Read and write sulla repo)`, 500);
  return r.json();
}

// Scrive più file in un unico commit sopra "parent". files = [{ path, content }]
async function commitFiles(parent, files, messaggio) {
  const c = await fetch(api(`/git/commits/${parent}`), { headers: intestazioni(), cache: "no-store" });
  if (!c.ok) throw errore(`GitHub ha risposto ${c.status} leggendo il commit`, 500);
  const baseTree = (await c.json()).tree.sha;
  const tree = await chiama("POST", "/git/trees", {
    base_tree: baseTree,
    tree: files.map(f => ({ path: f.path, mode: "100644", type: "blob", content: f.content }))
  }, "creazione tree");
  const commit = await chiama("POST", "/git/commits", { message: messaggio, tree: tree.sha, parents: [parent] }, "creazione commit");
  await chiama("PATCH", `/git/refs/heads/${enc(BRANCH())}`, { sha: commit.sha, force: false }, "aggiornamento branch");
  return commit.sha;
}

module.exports = { leggiHead, leggiFile, commitFiles };
