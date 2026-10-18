const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SESSION_SECRET = "s".repeat(40);
process.env.ADMIN_USERS = JSON.stringify({ anna: "pw-anna", mario: "pw-mario" });
process.env.GITHUB_TOKEN = "ghp_finto";

const { creaMock } = require("./mock-github");
const rapporti = require("../api/rapporti");
const chainApi = require("../api/chain");
const C = require("../lib/chain");
const { segreto } = require("../lib/archivio");

const doc = (id, extra = {}) => ({ id, titolo: "Titolo " + id, autore: "anna", categoria: "Rapporto", stato: "Bozza", data: "2026-10-01", abstract: "", parole_chiave: [], corpo: [{ tipo: "paragrafo", testo: "Ciao " + id }], note: [], bibliografia: [], ...extra });

function chiama(handler, { method = "GET", body, token } = {}) {
  return new Promise(resolve => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(o) { resolve({ status: this.code, body: o }); } };
    handler({ method, body, headers: token ? { authorization: "Bearer " + token } : {} }, res);
  });
}
const login = async u => (await chiama(rapporti, { method: "POST", body: { azione: "login", username: u, password: "pw-" + u } })).body.token;
const salva = (token, testi) => chiama(rapporti, { method: "POST", token, body: { azione: "salva", testi } });
const leggiChain = gh => JSON.parse(gh.file("chain.json")).blocchi;

test("prima modifica: genesi + modifica + creazione, tutto in un solo commit", async () => {
  const gh = creaMock({ "rapporti.json": JSON.stringify({ testi: [doc("uno"), doc("due")] }) });
  const t = await login("anna");
  const r = await salva(t, [doc("uno", { titolo: "Nuovo titolo", stato: "Pubblicato" }), doc("due"), doc("tre")]);
  assert.equal(r.status, 200);
  const b = leggiChain(gh);
  assert.deepEqual(b.map(x => x.azione), ["GENESI", "MODIFICA", "CREA"]);
  assert.equal(b[1].utente, "anna");
  assert.deepEqual(b[1].campiModificati, ["stato", "titolo"]);
  assert.match(b[1].riepilogo, /stato \(Bozza → Pubblicato\)/);
  assert.equal(b[1].hashPrima, C.hashDocumento(doc("uno")));
  assert.equal(b[2].hashPrima, null);
  assert.ok(C.verificaCatena(b, segreto()).valida);
  // un solo commit nuovo, con entrambi i file
  assert.equal(gh.commits[gh.head].parent, Object.keys(gh.commits)[0]);
  assert.ok(gh.file("chain.json") && JSON.parse(gh.file("rapporti.json")).testi.length === 3);
});

test("modifiche successive, eliminazione e riepilogo pubblico senza dati riservati", async () => {
  const gh = creaMock({});
  const t = await login("anna"), m = await login("mario");
  await salva(t, [doc("uno")]);
  await salva(m, [doc("uno", { corpo: [{ tipo: "paragrafo", testo: "diverso" }, { tipo: "separatore" }] })]);
  await salva(t, []);
  const b = leggiChain(gh);
  assert.deepEqual(b.map(x => x.azione), ["GENESI", "CREA", "MODIFICA", "ELIMINA"]);
  assert.equal(b[2].utente, "mario");
  assert.equal(b[2].dettagli.corpo.aggiunti, 2);
  assert.equal(b[3].hashDopo, null);
  assert.ok(C.verificaCatena(b, segreto()).valida);
  const pub = await chiama(chainApi);
  assert.equal(pub.body.valida, true);
  assert.equal(pub.body.coerente, true);
  assert.equal(pub.body.blocchi, 4);
  assert.ok(!JSON.stringify(pub.body).includes("Titolo"));
  const priv = await chiama(chainApi, { token: t });
  assert.equal(priv.body.blocchi.length, 4);
});

test("salvataggio senza cambiamenti: nessun blocco, nessun commit", async () => {
  const gh = creaMock({});
  const t = await login("anna");
  await salva(t, [doc("uno")]);
  const head = gh.head;
  const r = await salva(t, [doc("uno")]);
  assert.deepEqual(r.body.blocchi, []);
  assert.equal(gh.head, head);
});

test("manomissione di un blocco: rilevata", async () => {
  const gh = creaMock({});
  const t = await login("anna");
  await salva(t, [doc("uno")]); await salva(t, [doc("uno", { titolo: "x" })]);
  const b = leggiChain(gh);

  const a = JSON.parse(JSON.stringify(b)); a[1].utente = "mario";                      // cambio autore
  assert.equal(C.verificaCatena(a, segreto()).problemi[0].index, 1);

  const f = JSON.parse(JSON.stringify(b)); f[1].utente = "mario";                      // ricalcolo anche l'hash...
  f[1].hash = C.hashBlocco(f[1]); f[2].previousHash = f[1].hash; f[2].hash = C.hashBlocco(f[2]);
  const v = C.verificaCatena(f, segreto());                                            // ...ma senza segreto la firma non torna
  assert.equal(v.valida, false);
  assert.ok(v.problemi.some(p => /firma/.test(p.motivo)));

  const r = JSON.parse(JSON.stringify(b)); r.splice(1, 1);                             // blocco rimosso
  assert.equal(C.verificaCatena(r, segreto()).valida, false);
});

test("modifica fuori dal sito: rilevata dalla verifica e messa agli atti al salvataggio successivo", async () => {
  const gh = creaMock({});
  const t = await login("anna");
  await salva(t, [doc("uno"), doc("due")]);
  gh.scrivi("rapporti.json", JSON.stringify({ testi: [doc("uno", { titolo: "Manomesso" }), doc("tre")] }));   // a mano su GitHub

  const pub = await chiama(chainApi);
  assert.equal(pub.body.valida, true);        // la catena è integra...
  assert.equal(pub.body.coerente, false);     // ...ma i documenti non corrispondono

  await salva(t, [doc("uno", { titolo: "Manomesso" }), doc("tre"), doc("quattro")]);
  const b = leggiChain(gh);
  assert.deepEqual(b.slice(-4).map(x => x.azione), ["MODIFICA_ESTERNA", "CREA_ESTERNA", "ELIMINA_ESTERNA", "CREA"]);
  assert.ok(C.verificaCatena(b, segreto()).valida);
  assert.equal((await chiama(chainApi)).body.coerente, true);
});

test("chain.json in un formato sconosciuto non viene sovrascritto", async () => {
  const gh = creaMock({ "chain.json": JSON.stringify({ qualcosa: "di altro" }) });
  const t = await login("anna");
  const r = await salva(t, [doc("uno")]);
  assert.equal(r.status, 500);
  assert.match(r.body.error, /formato non riconosciuto/);
  assert.equal(JSON.parse(gh.file("chain.json")).qualcosa, "di altro");
});

test("conflitto con un altro commit: 409 e niente scritto", async () => {
  const gh = creaMock({});
  const t = await login("anna");
  gh.prePatch = s => s.scrivi("README.md", "altro");        // qualcuno committa mentre salviamo
  const r = await salva(t, [doc("uno")]);
  assert.equal(r.status, 409);
  assert.equal(gh.file("chain.json"), undefined);
});

test("senza token non si salva e non si legge il registro completo", async () => {
  creaMock({});
  assert.equal((await salva("falso", [doc("uno")])).status, 401);
  assert.equal((await chiama(chainApi, { token: "falso" })).status, 401);
});
