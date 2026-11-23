# MikroStats

<img width="1721" height="566" alt="image" src="https://github.com/user-attachments/assets/5cf93ba8-c889-44fd-acec-fd1fbaff5681" />

Dashboard de supervision temps réel pour switches **MikroTik SwOS** et routeurs **MikroTik RouterOS**, conçu pour tourner sur du matériel modeste (Orange Pi, RPi, NUC).

* **Un seul cycle de polling** par équipement, quel que soit le nombre de navigateurs ouverts (flux SSE unique).
* **Historique multi-résolution** en mémoire, écrit sur disque par lots atomiques.
* **Éditeur de schéma réseau** : ajouter / relier / déplacer les équipements, positions mémorisées.
* **Zéro framework, zéro étape de build** : `public/index.html` + `styles.css` + `app.js`, Chart.js servi localement depuis `/vendor` (aucun CDN).
* **Node.js 26 (Lithium)**, ESM, `node:test`, démarrage sans aucun avertissement.

---

## Prérequis

* **Node.js ≥ 26** (`.nvmrc` pointe sur `26` ; `engines.node` l'exige).

```bash
nvm use            # ou : apt/NodeSource pour installer Node 26
node -v            # v26.x
```

Aucune dépendance native : `npm audit` = 0 vulnérabilité.

---

## Installation

```bash
git clone https://github.com/SahranREAL/MikroStats---SwOS.git
cd MikroStats---SwOS
npm ci                 # ou : npm install
npm start              # http://<ip>:3000/
```

En développement (rechargement automatique) :

```bash
npm run dev            # node --watch --env-file-if-exists=.env server.js
```

> ⚠️ **Les fichiers de `public/*` sont mis en cache en mémoire pour toute la
> durée du processus.** Après avoir édité `public/index.html`, `public/styles.css`
> ou `public/app.js`, **redémarrez le serveur** (`Ctrl-C` puis `npm start`) avant
> de tester — sinon vous servez l'ancienne version.

### Docker

```bash
docker build -t mikrostats .
docker run -d -p 3000:3000 -v mikrostats-data:/app/data mikrostats
```

L'image est multi-étages (aucun compilateur, aucune dépendance de dev), tourne
en non-root et expose un `HEALTHCHECK` sur `/api/status`.

### Service permanent (systemd)

```bash
sudo cp deploy/mikrostats.service /etc/systemd/system/
sudo install -m 600 -o mikrostats /dev/null /etc/mikrostats.env
sudo nano /etc/mikrostats.env      # SWITCH_PASS, DASHBOARD_TOKEN, …
sudo systemctl daemon-reload
sudo systemctl enable --now mikrostats
```

Le service envoie `SIGTERM` : le serveur flush l'historique puis sort proprement.

---

## Premier démarrage

1. Le serveur crée `data/` avec, au premier lancement :
   * `data/token` — **jeton d'administration** (mode `0600`), requis pour toute
     écriture. Il est affiché dans les logs et demandé par la modale du frontend
     à la première modification.
   * `data/topology.json` — la topologie (positions comprises), écrit **atomiquement** et **uniquement si quelque chose a changé**.
   * `data/credentials.json` — identifiants chiffrés **AES-256-GCM**, clé dans
     `data/secrets.key` (`0600`). Les mots de passe ne sont **jamais** dans la
     topologie, ni dans une réponse d'API, ni dans les logs, ni dans le DOM.
   * `data/history/<id>.hst` — historique par équipement.
2. Ouvrez `http://<ip>:3000/`.
3. Le switch d'exemple est déjà là : **`172.22.22.2`**, utilisateur **`admin`**
   (casse sensible), mot de passe **vide**, 26 ports, polling 3 s.
4. Mode **Édition** sur la carte → **+ Équipement** pour ajouter un switch SwOS
   ou un routeur RouterOS, **+ Lien** pour relier deux ports réels, glisser-déposer
   pour placer, cadenas pour verrouiller une position.
5. Après modification : si un changement est détecté, le serveur écrit ; sinon
   **aucune écriture disque n'a lieu**.

---

## Configuration

Toutes les variables sont optionnelles (valeurs par défaut dans `config.js`).
Utilisez un fichier `.env` (`npm run dev` le lit automatiquement, sinon
`node --env-file=.env server.js`).

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Adresse et port d'écoute |
| `DATA_DIR` | `./data` | Topologie, identifiants, historique, jeton |
| `LOG_DIR` / `LOG_LEVEL` / `LOG_TARGET` | `./logs` / `info` / `file` | Journaux (`file`, `stdout`, `both`) |
| `AUTH_MODE` | `token` | `token` (écritures protégées), `none` (désactive l'auth), `basic` (derrière TLS) |
| `DASHBOARD_TOKEN` | *(généré)* | Jeton forcé ; sinon lu/écrit dans `data/token` |
| `AUTH_REQUIRED` | `0` | `1` = exige le jeton aussi pour les lectures |
| `WRITE_RATE_PER_MIN` | `60` | Limite d'écritures par minute et par IP |
| `BODY_LIMIT_BYTES` | `32768` | Taille max d'un corps de requête (32 Ko) |
| `MAX_DEVICES` / `MAX_LINKS` | `50` / `200` | Nombre max d'équipements / liens |
| `ALLOW_PUBLIC_TARGETS` | `0` | Autoriser des cibles hors RFC1918 (anti-SSRF) |
| `POLL_INTERVAL_MS` | `3000` | Intervalle par défaut (1 000 – 600 000 ms) |
| `POLL_CONCURRENCY` / `POLL_JITTER_MS` | `4` / `400` | Concurrence bornée + gigue |
| `DEVICE_TIMEOUT_MS` | `8000` | Délai max par requête (`AbortSignal.timeout`) |
| `POLL_BACKOFF_MAX_MS` | `30000` | Backoff borné après échecs |
| `HISTORY_FLUSH_MS` | `60000` | Écriture disque groupée de l'historique |
| `SSE_MAX_CLIENTS` / `SSE_HEARTBEAT_MS` | `32` / `20000` | Cap de clients SSE + heartbeat |
| `SWITCH_HOST` / `SWITCH_USER` / `SWITCH_PASS` | `172.22.22.2` / `admin` / *(vide)* | Migration du switch mono-appareil |
| `SWITCH_NAME` | `MikroTik CSS326` | Nom du switch hérité |
| `TOPOLOGY_FILE` / `CREDENTIALS_FILE` / `SECRETS_KEY_FILE` | dans `data/` | Chemins déplaçables |

### Migration depuis l'ancienne version

Un fichier `data/topology.json` absent ⇒ le serveur crée la topologie à partir
des variables `SWITCH_*` (ancien fonctionnement). Vos positions et liens ajoutés
ensuite sont conservés à la version suivante.

---

## Utilisation

* **Carte** : clic sur un équipement → son tableau de bord (fil d'Ariane en
  haut). Molette / pincement / flèches / `+` `−` / `0` pour zoomer-déplacer,
  bouton **Recentrer**.
* **Modes** : `Visualisation` (défaut) / `Édition` (ajout, modification,
  suppression, glisser-déposer, grille, réorganisation automatique, verrouillage).
* **Liens** : débit affiché au-dessus (sens de droite) et en dessous (sens de
  gauche), noms de port aux deux extrémités, couleur selon la charge
  (< 60 % vert, 60–85 % orange, > 85 % rouge, lien *down* en pointillés rouges).
* **Périodes** : 7 sélecteurs d'historique, zoom réversible, tri et filtre du
  tableau des ports, sparkline par port.
* **Connexion** : badge d'état en en-tête + bandeau « switch inaccessible » ;
  l'interface reste utilisable hors ligne.

Tout est accessible au clavier (nœuds et liens : `Entrée`/`Espace`).

---

## API

Toutes les réponses sont en JSON ; les écritures exigent
`Authorization: Bearer <token>` et, pour la topologie, un en-tête
`If-Match: <rev>` (sinon `412`).

| Méthode | Route | Rôle |
| --- | --- | --- |
| `GET` | `/api/topology` | Topologie publique (sans identifiants) |
| `PUT` | `/api/topology/layout` | Positions / verrous (écrit **seulement si changement**) |
| `GET` | `/api/devices` | Liste des équipements |
| `POST` | `/api/devices` | Ajouter |
| `PATCH` | `/api/devices/:id` | Modifier |
| `DELETE` | `/api/devices/:id` | Supprimer (+ liens + historique) |
| `POST` | `/api/devices/test` | « Tester la connexion » (latence, ports, identité) |
| `GET` | `/api/links` | Liste des liens |
| `POST` / `PATCH` / `DELETE` | `/api/links[/:id]` | Créer / modifier / supprimer |
| `GET` | `/api/devices/:id/history?range=` | Historique (7 périodes) |
| `GET` | `/api/devices/:id/stats` | État live d'un équipement |
| `GET` | `/api/stream` | **SSE unique** : `hello`, `sample`, `links`, `status`, `statusChange`, `topology`, `alerts` |
| `GET` | `/api/status` | États + `history` + `topology` + `manager` + **`io`** (budget I/O) |
| `GET` | `/api/alerts` | Alertes et notificateurs |
| `GET` | `/api/stats`, `/api/history` | Routes héritées (switch racine) |

### Budget I/O (`GET /api/status` → `io`)

```jsonc
"io": {
  "device": { "requests": 132, "errors": 0, "responseBytes": 1712832, "perHost": [...] },
  "sse":    { "frames": 3780, "bytes": 3636056, "clients": 2, "perClient": [...] },
  "disk":   { "writes": 60, "bytesWritten": 462000 }
}
```

Compteurs cumulés depuis le démarrage : requêtes vers les équipements, octets
réellement écrits vers les navigateurs (par client), écritures disque.
Aucun travail, aucun log et aucune écriture n'a lieu quand rien ne change.

---

## Tests

```bash
npm test           # unit + history + transit + topology + linkrates (rapide)
npm run test:all   # + api (serveur réel) — 89 tests
npm run test:ui    # interface complète dans jsdom (serveur vivant requis)
npm run soak       # 4 min en simulation : mémoire, flush, écritures
```

Le test d'interface (`test/ui.test.js`, 110 contrôles) démarre contre un
serveur déjà lancé :

```bash
DATA_DIR=/tmp/ms PORT=3000 node server.js &
UI_DATA_DIR=/tmp/ms npm run test:ui
```

`UI_DATA_DIR` (ou `UI_TOKEN`) fournit le jeton pour les scénarios d'écriture ;
sans jeton, ces scénarios sont ignorés au lieu d'échouer sur un `401`.

CI (`.github/workflows/ci.yml`) : Node 26 **et** 27, `npm audit`, démarrage avec
`--throw-deprecation` (aucun avertissement toléré), suite UI, build Docker.

---

## Mesures (60 s, serveur de test)

| Indicateur | 1 navigateur | 11 navigateurs |
| --- | --- | --- |
| Requêtes vers les équipements | **22/min** | **22/min** |
| Écritures disque | **1/min** (flush groupé 60 s) | **1/min** |
| Octets reçus des équipements | ~258 kB/min | ~258 kB/min |
| Frames SSE / minute | 63 | 63 |
| Octets **par client** / minute | ~61 kB | ~61 kB |
| Écritures si rien ne change | **0** | **0** |

Le coût d'un navigateur supplémentaire est donc ~61 kB/min et **zéro requête
supplémentaire vers le matériel**.

---

## Comprendre IN et OUT

La vue globale **additionne tous les ports**. Un paquet traversant le switch est
compté deux fois : une fois en RX sur le port de réception et une fois en TX sur
le port de transmission. Les totaux IN et OUT peuvent donc apparaître
symétriques, ce qui est le comportement normal d'un switch matériel et non un
bug.

---

## Hypothèses de conception

* **Routeurs RouterOS : REST v7 par défaut**, repli automatique sur l'API binaire
  (8728/8729) si le REST ne répond pas — aucun matériel de test disponible, le
  REST est le plus simple (une requête HTTP Basic, sans handshakes).
* **Jeton d'administration unique**, généré au premier lancement et
  configurable via `DASHBOARD_TOKEN` (une seule valeur, pas de rotation).
* **Dimensionnement** : ~50 équipements max, polling 1–5 s (bornes
  `POLL_MIN_INTERVAL_MS` / `POLL_MAX_INTERVAL_MS`), concurrence 4.
* Compte SwOS par défaut : `admin` (casse sensible), mot de passe vide.
* Sécurité : CSP `default-src 'none'` (+ `script-src/style-src 'self'`), aucune
  valeur dynamique injectée en HTML, anti-SSRF sur les cibles, corps limité à
  32 Ko, 60 écritures/min/IP.
