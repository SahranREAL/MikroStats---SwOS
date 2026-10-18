# MikroStats - Édition SwOS

Un tableau de bord léger et intuitif pour suivre l'utilisation de votre bande passante sur vos switchs MikroTik équipés de SwOS.

## Aperçu

<img width="1899" height="944" alt="image" src="https://github.com/user-attachments/assets/b01d7eab-75cd-4298-917f-4da50b5b463c" />

<br>
<br>
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

La configuration s'effectue actuellement dans le fichier config.js. Vous devez y modifier l'adresse IP du switch (host), ainsi que renseigner le nom d'utilisateur (username) et le mot de passe (password).

## Update :

- Prise en charge d'un fichier .env pour la gestion des variables d'environnement.

- Interface web de configuration initiale lors du premier démarrage de l'application.

---
*Remarque : Le dépôt pour la version **MikroStats RouterOS** sera disponible prochainement.*
