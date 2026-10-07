# FGCI Rapporti — sito su Vercel

File: `index.html` (pubblico), `redazione.html` (scrittura), `api/rapporti.js` (funzione Vercel), `fgci.png` (logo: **sostituisci il segnaposto**),
`assets/css/rapporti.css`, `assets/js/{rapporti-core,rapporti,rapporti-redazione,pdf-export}.js`.
Dati: `rapporti.json` nella repo `fgcifo/DATA` (creato al primo salvataggio).

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

\* serve almeno `ADMIN_USERNAME`+`ADMIN_PASSWORD` oppure `ADMIN_USERS`.
