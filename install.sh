#!/usr/bin/env bash
# =============================================================================
#  MikroStats — script d'installation
#
#  Prépare tout ce qu'il faut pour que `npm start` fonctionne directement :
#    1. Node.js à la bonne version (celle de .nvmrc / engines.node, ≥ 26)
#       — installé via nvm si absent ou trop ancien ;
#    2. dépendances npm exactement figées par package-lock.json (npm ci) ;
#    3. dossiers data/ et logs/ présents et accessibles en écriture ;
#    4. vérifications finales (versions, modules, syntaxe, fichiers vendor).
#
#  Ne lance PAS l'application.
#
#  Usage :
#    ./install.sh            installation complète (dépendances de dev incluses,
#                            nécessaires pour `npm test` / `npm run test:ui`)
#    ./install.sh --prod     uniquement les dépendances de production (express)
#    ./install.sh --test     installation + exécution de `npm test`
#    ./install.sh --help
# =============================================================================
set -euo pipefail

NVM_VERSION="v0.40.3"

# --- Options ------------------------------------------------------------------
OMIT_DEV=0
RUN_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --prod|--production) OMIT_DEV=1 ;;
    --test)              RUN_TESTS=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Option inconnue : $arg (voir --help)" >&2; exit 2 ;;
  esac
done

# --- Affichage ----------------------------------------------------------------
if [ -t 1 ]; then
  C_B=$'\033[1m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_0=$'\033[0m'
else
  C_B=""; C_G=""; C_Y=""; C_R=""; C_0=""
fi
step() { printf '\n%s==> %s%s\n' "$C_B" "$*" "$C_0"; }
ok()   { printf '  %s✔%s %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_Y" "$C_0" "$*"; }
die()  { printf '\n%s✘ %s%s\n' "$C_R" "$*" "$C_0" >&2; exit 1; }

# --- Se placer à la racine du projet -------------------------------------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
[ -f package.json ] || die "package.json introuvable dans $ROOT"

# --- Ne pas tourner en root ----------------------------------------------------
# Node est installé par utilisateur (nvm) et node_modules/, data/, logs/ doivent
# appartenir à celui qui fera `npm start`. Lancé via sudo, on rend la main à
# l'utilisateur d'origine après avoir corrigé les droits.
if [ "$(id -u)" -eq 0 ]; then
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    warn "Lancé avec sudo : correction des droits puis reprise en tant que '$SUDO_USER'."
    for d in node_modules data logs package-lock.json; do
      [ -e "$d" ] && chown -R "$SUDO_USER":"$(id -gn "$SUDO_USER")" "$d"
    done
    exec sudo -u "$SUDO_USER" -H bash "$0" "$@"
  fi
  warn "Exécution en root : node_modules/, data/ et logs/ appartiendront à root."
fi

# --- Version de Node requise ----------------------------------------------------
REQUIRED_MAJOR=""
if [ -f .nvmrc ]; then
  REQUIRED_MAJOR="$(tr -dc '0-9.' < .nvmrc | cut -d. -f1)"
fi
if [ -z "$REQUIRED_MAJOR" ]; then
  REQUIRED_MAJOR="$(grep -o '"node"[^"]*"[^"]*"' package.json | grep -o '[0-9]\+' | head -n1 || true)"
fi
REQUIRED_MAJOR="${REQUIRED_MAJOR:-26}"

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  command -v nvm >/dev/null 2>&1
}

step "1/4  Node.js ≥ $REQUIRED_MAJOR"

# nvm d'abord (si présent), pour respecter .nvmrc même si un autre Node traîne.
if load_nvm; then
  nvm use --silent "$REQUIRED_MAJOR" >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1 || [ "$(node_major)" -lt "$REQUIRED_MAJOR" ]; then
  if command -v node >/dev/null 2>&1; then
    warn "Node $(node -v) détecté — version $REQUIRED_MAJOR requise."
  else
    warn "Node.js absent."
  fi

  if ! load_nvm; then
    step "     Installation de nvm $NVM_VERSION"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | PROFILE=/dev/null bash
    elif command -v wget >/dev/null 2>&1; then
      wget -qO- "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | PROFILE=/dev/null bash
    else
      die "Ni curl ni wget disponibles : installez l'un des deux (sudo apt install curl) puis relancez."
    fi
    load_nvm || die "nvm n'a pas pu être chargé après installation."
    warn "Ajoutez à votre ~/.bashrc pour garder nvm :"
    warn '  export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
  fi

  step "     Installation de Node $REQUIRED_MAJOR via nvm"
  nvm install "$REQUIRED_MAJOR"
  nvm alias default "$REQUIRED_MAJOR" >/dev/null
  nvm use --silent "$REQUIRED_MAJOR" >/dev/null
fi

[ "$(node_major)" -ge "$REQUIRED_MAJOR" ] || die "Node $(node -v) toujours trop ancien."
command -v npm >/dev/null 2>&1 || die "npm introuvable alors que Node est installé."
ok "node $(node -v)  ($(command -v node))"
ok "npm  v$(npm -v)"

# --- Droits sur les dossiers -----------------------------------------------------
# Un ancien `sudo npm install` / `sudo npm start` laisse node_modules/, data/ ou
# logs/ à root : npm et le serveur échouent ensuite en EACCES.
step "2/4  Dossiers et droits"
NEED_FIX=()
for d in node_modules data logs; do
  if [ -e "$d" ] && { [ ! -w "$d" ] || [ ! -r "$d" ] || [ ! -x "$d" ] || \
       [ -n "$(find "$d" ! -user "$(id -u)" -print -quit 2>/dev/null || echo x)" ]; }; then
    NEED_FIX+=("$d")
  fi
done
if [ -e package-lock.json ] && [ ! -w package-lock.json ]; then
  NEED_FIX+=("package-lock.json")
fi
if [ "${#NEED_FIX[@]}" -gt 0 ]; then
  warn "Appartiennent à un autre utilisateur : ${NEED_FIX[*]}"
  if command -v sudo >/dev/null 2>&1; then
    warn "Correction avec sudo chown (mot de passe éventuellement demandé)…"
    sudo chown -R "$(id -u)":"$(id -g)" "${NEED_FIX[@]}"
    ok "Droits corrigés."
  else
    die "Corrigez les droits : chown -R $(id -un) ${NEED_FIX[*]}"
  fi
fi
mkdir -p data logs
chmod 700 data
ok "data/ et logs/ prêts"

# --- Dépendances npm -------------------------------------------------------------
step "3/4  Dépendances npm"
NPM_FLAGS=(--no-fund --no-audit)
[ "$OMIT_DEV" -eq 1 ] && NPM_FLAGS+=(--omit=dev)

if [ -f package-lock.json ]; then
  # npm ci : versions exactes du lockfile, node_modules repart de zéro.
  if ! npm ci "${NPM_FLAGS[@]}"; then
    warn "package-lock.json désynchronisé de package.json : repli sur npm install."
    npm install "${NPM_FLAGS[@]}"
  fi
else
  npm install "${NPM_FLAGS[@]}"
fi
ok "Dépendances installées"

# --- Vérifications ---------------------------------------------------------------
step "4/4  Vérifications"
node -e "import('express').then(()=>{}).catch(e=>{console.error(e.message);process.exit(1)})" \
  || die "Le module express ne se charge pas."
ok "express $(node -p 'require("express/package.json").version')"
if [ "$OMIT_DEV" -eq 0 ]; then
  ok "jsdom   $(node -p 'require("jsdom/package.json").version') (tests UI)"
fi

for f in server.js config.js lib/*.js public/app.js; do
  [ -f "$f" ] && { node --check "$f" || die "Erreur de syntaxe dans $f"; }
done
ok "Syntaxe JS valide"

for f in public/index.html public/styles.css public/app.js \
         public/vendor/chart.umd.js public/vendor/chartjs-plugin-zoom.min.js public/vendor/hammer.min.js; do
  [ -f "$f" ] || die "Fichier manquant : $f"
done
ok "Frontend et librairies vendor présents (Chart.js servi localement)"

if [ "$RUN_TESTS" -eq 1 ]; then
  [ "$OMIT_DEV" -eq 1 ] && warn "--prod : les tests UI (jsdom) ne sont pas disponibles."
  step "     npm test"
  npm test
fi

PORT_SHOWN="${PORT:-3000}"
printf '\n%s✔ Installation terminée.%s\n' "$C_G" "$C_0"
cat <<EOF

  Lancer l'application :   npm start
  Puis ouvrir :            http://localhost:${PORT_SHOWN}/
  Développement :          npm run dev
  Tests :                  npm test

EOF
if load_nvm >/dev/null 2>&1 && [ "$(command -v node)" != "/usr/bin/node" ]; then
  echo "  (Node vient de nvm : dans un nouveau terminal, faites 'nvm use' si besoin.)"
  echo
fi
