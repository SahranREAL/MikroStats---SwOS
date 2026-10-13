# MikroStats - Édition SwOS

Un tableau de bord léger et intuitif pour suivre l'utilisation de votre bande passante sur vos switchs MikroTik équipés de SwOS.

## Aperçu

MikroStats vous permet d'obtenir un graphique en temps réel ainsi que des statistiques clés sur l'utilisation de la bande passante de vos équipements réseau, directement depuis une interface claire.

## Prérequis

* Un switch MikroTik compatible (CRS avec SwOS ou série CSS)
* **SwOS 2.19** ou supérieur (non testé sur les versions antérieures)
* **Node.js 20** (mise à jour vers Node.js 26 prévue prochainement)

## Installation et Démarrage

1. Installez les dépendances du projet :
   ```bash
   npm install
   ```

2. Lancez l'application :
   ```bash
   npm start
   ```

## Configuration

La configuration s'effectue directement via le fichier `.env` situé à la racine du projet. Assurez-vous d'y renseigner les informations de connexion de votre switch (adresse IP, identifiants) ainsi que les autres paramètres demander.

---

*Remarque : Le dépôt pour la version **MikroStats RouterOS** sera disponible prochainement.*