# FGCI Rapporti — sito su Vercel

File: `index.html` (pubblico), `redazione.html` (scrittura), `api/rapporti.js` (funzione Vercel), `fgci.png` (logo: **sostituisci il segnaposto**),
`assets/css/rapporti.css`, `assets/js/{rapporti-core,rapporti,rapporti-redazione,pdf-export}.js`.
Dati: `rapporti.json` e `chain.json` nella repo `fgcifo/DATA` (creati al primo salvataggio).

## Variabili d'ambiente (Vercel → Project → Settings → Environment Variables)
| Nome | Obbligatoria | Valore |
|---|---|---|
| `GITHUB_TOKEN` | sì | Fine-grained token GitHub, solo repo `fgcifo/DATA`, permesso **Contents: Read and write** |
| `SESSION_SECRET` | sì | stringa casuale lunga (≥ 32 caratteri) per firmare le sessioni |
| `ADMIN_USERNAME` + `ADMIN_PASSWORD` | sì* | accesso alla redazione |
| `ADMIN_USERS` | no* | più redattori, JSON: `{"mario":"pw1","anna":"pw2"}` |
| `GITHUB_REPO` | no | default `fgcifo/DATA` |
| `GITHUB_BRANCH` | no | default `main` |
| `GITHUB_FILE` | no | default `rapporti.json` |
| `GITHUB_CHAIN_FILE` | no | default `chain.json` |
| `CHAIN_SECRET` | consigliata | segreto che firma i blocchi (≥ 32 caratteri). Se manca si usa `SESSION_SECRET`. **Non cambiarlo dopo l'attivazione**: i blocchi già firmati risulterebbero non validi |

\* serve almeno `ADMIN_USERNAME`+`ADMIN_PASSWORD` oppure `ADMIN_USERS`.

## Registro a blocchi delle modifiche (`chain.json`)

Ogni salvataggio dalla redazione viene confrontato con lo stato precedente: ogni creazione, modifica o eliminazione di un documento diventa un **blocco** in `chain.json`, collegato al precedente con SHA-256 e firmato con HMAC (`CHAIN_SECRET`).
`rapporti.json` e `chain.json` sono scritti **nello stesso commit** (Git Data API): o passano entrambi o nessuno.

| Blocco | Contenuto |
|---|---|
| `index`, `timestamp`, `previousHash` | posizione, momento, collegamento al blocco precedente |
| `utente`, `azione` | chi e cosa: `CREA`, `MODIFICA`, `ELIMINA` (o `*_ESTERNA`, vedi sotto) |
| `documento`, `hashPrima`, `hashDopo` | documento toccato e SHA-256 del suo contenuto prima/dopo |
| `campiModificati`, `dettagli`, `riepilogo` | che cosa è cambiato |
| `hash`, `firma` | impronta del blocco e firma del server |

- Il primo blocco (`GENESI`) registra l'impronta dei documenti già presenti all'attivazione.
- Se `rapporti.json` viene modificato **fuori dal sito** (a mano su GitHub), la verifica lo segnala e al salvataggio successivo il cambiamento è messo agli atti come `*_ESTERNA`.
- Se `chain.json` esiste già con un formato diverso da `{"versione":1,"blocchi":[...]}`, il sito si rifiuta di sovrascriverlo.
- `GET /api/chain` senza token: solo esito (`valida`, `coerente`, n. blocchi, ultimo hash) — nessun titolo né bozza. Con token: registro completo.
- Pagina `registro.html` (redazione): cronologia, esito della verifica, download di `chain.json`.
- Non vengono registrati i login (non sono modifiche). Il contenuto completo di ogni versione resta nella storia git di `rapporti.json`; il registro ne conserva l'impronta.

Test: `npm test` (GitHub simulato in memoria, nessuna rete).
