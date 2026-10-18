// Mini GitHub in memoria: solo gli endpoint usati da lib/github.js.
const crypto = require("crypto");

function creaMock(fileIniziali) {
  const commits = {};                       // sha -> { tree: {path: content}, parent }
  const nuovoSha = s => crypto.createHash("sha1").update(s + Math.random()).digest("hex");
  const primo = nuovoSha("c0");
  commits[primo] = { tree: { ...fileIniziali }, parent: null };
  const stato = { head: primo, commits, chiamate: [], prePatch: null };
  const trees = {};

  const json = (o, s = 200) => ({ ok: s < 400, status: s, json: async () => o, text: async () => JSON.stringify(o) });

  global.fetch = async (url, opts = {}) => {
    const u = new URL(url), p = decodeURIComponent(u.pathname).replace(/^\/repos\/[^/]+\/[^/]+/, "");
    const metodo = opts.method || "GET";
    stato.chiamate.push(metodo + " " + p);
    let m;
    if (metodo === "GET" && (m = p.match(/^\/git\/ref\/heads\/(.+)$/))) return json({ object: { sha: stato.head } });
    if (metodo === "GET" && (m = p.match(/^\/contents\/(.+)$/))) {
      const ref = u.searchParams.get("ref");
      const c = commits[ref] || commits[stato.head];
      return m[1] in c.tree ? { ok: true, status: 200, text: async () => c.tree[m[1]] } : json({}, 404);
    }
    if (metodo === "GET" && (m = p.match(/^\/git\/commits\/(.+)$/))) { const sha = nuovoSha("t"); trees[sha] = commits[m[1]].tree; return json({ tree: { sha } }); }
    if (metodo === "POST" && p === "/git/trees") {
      const b = JSON.parse(opts.body), t = { ...trees[b.base_tree] };
      b.tree.forEach(e => { t[e.path] = e.content; });
      const sha = nuovoSha("tree"); trees[sha] = t; return json({ sha });
    }
    if (metodo === "POST" && p === "/git/commits") {
      const b = JSON.parse(opts.body), sha = nuovoSha("commit");
      commits[sha] = { tree: trees[b.tree], parent: b.parents[0], message: b.message };
      return json({ sha });
    }
    if (metodo === "PATCH" && (m = p.match(/^\/git\/refs\/heads\/(.+)$/))) {
      if (stato.prePatch) { const f = stato.prePatch; stato.prePatch = null; f(stato); }
      const b = JSON.parse(opts.body);
      if (commits[b.sha].parent !== stato.head) return json({ message: "Update is not a fast forward" }, 422);
      stato.head = b.sha; return json({});
    }
    return json({ message: "non gestito: " + metodo + " " + p }, 500);
  };

  stato.file = (path) => commits[stato.head].tree[path];
  stato.scrivi = (path, contenuto) => {                    // simula un commit fatto a mano su GitHub
    const sha = nuovoSha("manuale");
    commits[sha] = { tree: { ...commits[stato.head].tree, [path]: contenuto }, parent: stato.head };
    stato.head = sha;
  };
  return stato;
}

module.exports = { creaMock };
