# MikroStats

<img width="1721" height="566" alt="image" src="https://github.com/user-attachments/assets/5cf93ba8-c889-44fd-acec-fd1fbaff5681" />

Dashboard de supervision temps réel pour switch **MikroTik SwOS**, conçu pour tourner sur du matériel modeste (Orange Pi, RPi, NUC).

* **Un seul polling** backend pour tous les navigateurs (SSE).
* **Historique** en RAM + SQLite avec agrégation par paliers.
* **Compteurs 64 bits** décodés correctement, sans pics parasites après un reset.

---

## Prérequis

* **Node.js** : Version 18 (actuelle) • *Migration prochaine vers Node.js 26*.

---

## Installation

```bash
git clone https://github.com/SahranREAL/mikrostats.git
cd mikrostats
npm install --omit=dev

```

*Note (ARM / Orange Pi) :* `better-sqlite3` est une dépendance native. Si aucun binaire précompilé ne correspond à votre architecture :

```bash
sudo apt install -y build-essential python3
npm install --omit=dev --build-from-source

```

---

## Configuration

Créez et configurez un fichier d'environnement (ou utilisez les variables par défaut de `config.js`) :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `SWITCH_HOST` | `172.22.22.2` | Adresse IP du switch |
| `SWITCH_USER` | `admin` | Identifiant SwOS |
| `SWITCH_PASS` | *(vide)* | Mot de passe SwOS |
| `PORT` | `3000` | Port d'écoute HTTP |
| `DASHBOARD_TOKEN` | *(désactivé)* | Si défini, exige `Authorization: Bearer <token>` |

---

## Démarrage

### En mode développement

```bash
npm start

```

Puis accédez à l'interface sur `http://<ip>:3000/`.

### En service permanent (systemd)

```bash
sudo cp deploy/mikrostats.service /etc/systemd/system/
sudo install -m 600 /dev/null /etc/mikrostats.env
# Éditez /etc/mikrostats.env pour y placer vos identifiants (SWITCH_PASS, etc.)
sudo systemctl daemon-reload
sudo systemctl enable --now mikrostats

```

---

## Tests

```bash
npm test                  # Tests unitaires et de rétention (~5 s)
npm run test:unit         # Parsing, débits, ring buffer, agrégation
npm run test:transit      # Validation des flux IN / OUT

```

---

## Comprendre IN et OUT

La vue globale **additionne tous les ports**. Un paquet traversant le switch est compté deux fois : une fois en RX sur le port de réception et une fois en TX sur le port de transmission. Les totaux IN et OUT peuvent donc apparaître symétriques, ce qui est le comportement normal d'un switch matériel et non un bug.
