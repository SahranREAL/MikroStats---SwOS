# MikroStats

Dashboard de supervision temps réel pour switch **MikroTik SwOS**, conçu pour
tourner en permanence sur du matériel modeste (Orange Pi, RPi, vieux NUC).

- **Un seul polling** backend pour tous les navigateurs ouverts (SSE).
- **Historique** en RAM (2 h) + SQLite (30 jours) avec agrégation par paliers.
- **Compteurs 64 bits** décodés correctement, **zéro** débit avant le premier
  échantillon, **jamais** de pic après un reset de compteur ou un incident.
- Reprise automatique, arrêt propre, journalisation bornée.

---

## Installation

```bash
cd /media/loris/projets/MikroStats
npm install --omit=dev          # better-sqlite3 est natif : voir "ARM" plus bas
```

`better-sqlite3` est une dépendance native. Sur x86 un binaire précompilé est
téléchargé automatiquement ; sur ARM (Orange Pi), si aucun binaire ne correspond
à votre ABI, installez les outils de compilation :

```bash
sudo apt install -y build-essential python3
npm install --omit=dev --build-from-source
```

## Configuration

Tout se règle par variables d'environnement (voir `config.js`).

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `SWITCH_HOST` | `172.22.22.2` | Adresse du switch |
| `SWITCH_USER` | `admin` | Identifiant SwOS |
| `SWITCH_PASS` | *(vide)* | Mot de passe SwOS |
| `PORT` | `3000` | Port d'écoute HTTP |
| `HOST` | `0.0.0.0` | Interface d'écoute |
| `POLL_INTERVAL_MS` | `3000` | Intervalle de polling |
| `RAM_POINTS` | `1200` | Points conservés en RAM (~1 h) |
| `DASHBOARD_TOKEN` | *(désactivé)* | Si défini, exige `Authorization: Bearer <token>` |
| `DB_FILE` | `./data/history.db` | Base SQLite |
| `LOG_DIR` | `./logs` | Répertoire des journaux |

**Ne mettez jamais le mot de passe du switch dans un fichier versionné.**
Utilisez un fichier d'environnement systemd, voir plus bas.

### Compatibilité SwOS

Les fichiers de données ont changé de nom avec le firmware **SwOS 2.19** :
l'ancien `/!stats.b` redirige désormais vers l'interface web, la bonne URL est
`/stats.b`. MikroStats essaie automatiquement les deux chemins (et le bon) au
premier poll, puis mémorise celui qui répond — aucun réglage n'est nécessaire,
que le switch soit en 2.13 ou en 2.19+. Le chemin découvert est journalisé :
`swos stats endpoint: /stats.b`.
`SWITCH_STATS_PATH` / `SWITCH_LINK_PATH` restent disponibles pour forcer une
URL particulière.

## Démarrage

```bash
npm start                 # ou : node server.js
```

Puis ouvrez `http://<ip>:<port>/`.

## Mise en service permanente (systemd)

```bash
sudo cp deploy/mikrostats.service /etc/systemd/system/
sudo install -m 600 /dev/null /etc/mikrostats.env
sudo nano /etc/mikrostats.env          # SWITCH_USER / SWITCH_PASS / DASHBOARD_TOKEN

sudo systemctl daemon-reload
sudo systemctl enable --now mikrostats
sudo systemctl status mikrostats
journalctl -u mikrostats -f            # le journal applicatif est dans logs/
```

Adaptez `WorkingDirectory`, `User` et `ReadWritePaths` du fichier unité si vous
installez le projet ailleurs que `/media/loris/projets/MikroStats`.

> `DASHBOARD_TOKEN` protège l'API. L'interface web appelle l'API avec
> `fetch`, elle ne peut donc pas lire un token placé uniquement dans
> `localStorage` : réservez ce mode à un accès via reverse proxy, ou
>.Modifiez `public/app.js` pour transmettre le token.

## Tests

```bash
npm test                  # unitaires + rétention (hors ligne, ~5 s)
npm run test:unit         # 26 tests : parsing, débits, ring buffer, statut, agrégation
npm run test:retention    # purge des paliers 5s / 30s / 300s
npm run test:flush        # les echantillons non flushes sont-ils visibles ?
npm run test:transit      # IN/OUT sur un flux unidirectionnel et sur un flux traversant
npm run soak              # 4 min simulées : mémoire, écriture, exactitude
```

La suite UI (jsdom, 44 vérifications) a besoin d'un serveur actif :

```bash
npm start &               # terminal 1
npm run test:ui           # terminal 2
```

## API

| Route | Description |
| --- | --- |
| `GET /api/stats` | Dernier échantillon par port + totaux + statut |
| `GET /api/history?range=5m\|15m\|1h\|6h\|24h\|7d\|30d&port=all\|N` | Série temporelle agrégée |
| `GET /api/status` | Santé du backend, compteurs, clients SSE |
| `GET /api/stream` | Flux SSE (`stats`, `status`, `alert`, `heartbeat`) |
| `GET /api/alerts` | Historique des alertes |

Toutes les réponses sont en JSON et incluent `success: true|false` avec un
message `error` explicite en cas de rejet (paramètre invalide compris).

## Rétention

| Palier | Résolution | Conservation |
| --- | --- | --- |
| RAM | 3 s | ~1 h (1200 points) |
| SQLite 1 | 5 s | 2 h |
| SQLite 2 | 30 s | 3 jours |
| SQLite 3 | 300 s | 30 jours |

L'écriture SQLite est groupée toutes les 60 s ; la purge et le checkpoint
WAL sont exécutés périodiquement et à l'arrêt.

## Journalisation

`logs/mikrostats.log`, rotation automatique, taille bornée. Les erreurs
répétitives (perte du switch) sont limitées à une ligne par minute par clé.

## Sécurité

- Aucun `eval` / `new Function` : le format SwOS est analysé par un parser
  dedicated, à prototype nul, avec clés limitées au format SwOS.
- Protection contre le path traversal sur les routes de fichiers.
- En-têtes `Content-Security-Policy`, `X-Frame-Options`, `nosniff`,
  `Referrer-Policy`, `Cache-Control`.
- Authentification par token optionnelle (`DASHBOARD_TOKEN`).

## Comprendre IN et OUT

La vue « global » **additionne les 26 ports**. Or un même paquet est compté
deux fois par le switch : une fois en RX sur le port qui le reçoit, une fois en
TX sur le port qui le transmet.

Un téléchargement de 500 Mbit/s sur un appareil branché au port 2 donne donc :

| | IN | OUT |
|---|---|---|
| port 1 (uplink, vers Internet) | 500 Mbit/s | ~0 |
| port 2 (votre appareil) | ~0 | 500 Mbit/s |
| **total du switch** | **500 Mbit/s** | **500 Mbit/s** |

Les deux totaux affichent 500 : c'est le comportement normal d'un switch, pas une
mesure erronée. Chaque port, lui, reste parfaitement unidirectionnel — regardez
la carte du port concerné pour connaître le sens réel du trafic.

`npm run test:transit` vérifie les deux cas : un flux unidirectionnel (IN 500 /
OUT 0) et un flux traversant (chaque port unidirectionnel, total IN ≈ OUT).

## Diagnostic IN/OUT

Si IN et OUT semblent toujours identiques, ce n'est généralement pas un bug du
dashboard mais du trafic réellement symétrique sur le réseau. L'outil suivant
enregistre les deux directions port par port et tranche :

```bash
npm start &                                    # terminal 1
node tools/capture-inout.js 60                 # terminal 2, puis lancez le speedtest
CAPTURE_THRESHOLD_BPS=1000000 node tools/capture-inout.js 30   # seuil bas
```

Il écrit un CSV et affiche un verdict. Le verdict **transit mirroring**
(`portA.in ≈ portB.out` et `portA.out ≈ portB.in`) n'est **pas** un bug : un
switch compte les mêmes octets en RX sur le port qui les reçoit et en TX sur
celui qui les transmet, et deux machines qui se parlent donnent exactement ce
signal. Ce n'est un problème que si ce trafic apparaît sur des ports où rien
n'est branché, ou s'il ne s'arrête jamais.

## Licence

ISC
