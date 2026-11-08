# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Règle de branche (OBLIGATOIRE)

**Tout développement se fait sur la branche `developpe`.** Ne jamais travailler directement sur `main`, ne jamais fusionner `developpe` dans `main` ni pousser vers `main`/`origin` sans demande explicite de l'utilisateur. `main` est lue par les launchers déployés (manifest.json, news.json) : une erreur dessus touche tous les joueurs. Avant de commencer, vérifier avec `git branch --show-current` qu'on est bien sur `developpe`.

## Règles permanentes

1. **Changelog public (OBLIGATOIRE).** À chaque modification du launcher, mettre à jour [CHANGELOG.md](CHANGELOG.md), organisé par version du launcher (la version de `package.json`), avec trois rubriques : **Nouveautés**, **Améliorations**, **Corrections**.
   - Il est destiné aux **joueurs** : français simple, uniquement ce qui est visible ou utile pour eux.
   - **Jamais** de détail technique (noms de fonctions, fichiers, code, protocoles, chemins internes) ni d'information sensible (clés, jetons, adresses internes).
   - Ne rien inventer : une modification purement interne (refactoring, tests, outils d'administration, documentation) n'a **pas** d'entrée. Dans ce cas, relire le changelog et le dire dans le compte rendu : « aucune entrée publique n'était justifiée ».
   - Quand la version de `package.json` change, ouvrir une nouvelle section de version en haut du fichier.
2. **Identité visuelle (OBLIGATOIRE).** Préserver l'identité visuelle actuelle du launcher (couleurs, logo, fond, ambiance, typographie, structure générale). **Demander l'accord de l'utilisateur avant toute modification importante de l'interface** ; proposer d'abord, montrer (description ou capture), puis modifier seulement après validation. Les correctifs mineurs (bug d'affichage, texte, alignement) restent possibles sans demande préalable, mais doivent respecter le style existant.
3. **Branche** : voir la règle ci-dessus.

## Project

Launcher Electron (Windows uniquement, UI et logs en français) pour le modpack Minecraft **CobbleRealm** (Cobblemon, Minecraft 1.21.1 + Fabric). Il connecte le joueur via Microsoft, synchronise le modpack fichier par fichier, installe Java si besoin, puis lance le jeu avec `minecraft-launcher-core` (MCLC).

## Commandes

- `npm start` : lance l'app en dev (`electron .`).
- `npm test` : toutes les suites de tests automatiques (sans réseau, sans compte Microsoft).
- `npm run build` : crée l'installeur NSIS Windows dans `dist/` (via `tools/build.js` : electron-builder avec nouvelle tentative automatique si l'antivirus verrouille un fichier, erreur EPERM/EBUSY). Pour tester sans écraser `dist/` : `npm run build -- --config.directories.output=build-out`.
- `npm run release` : build + publication sur GitHub Releases (variable `GH_TOKEN` requise) pour l'auto-update.
- `node tools/publish.js <dossierSource> --version x.y.z` : prépare une publication du modpack (manifest v2 + fichiers nommés par leur SHA-256 + `UPLOAD.md`). Ne publie rien, n'écrit jamais dans le dossier source. `--dry-run` simule ; `--check <manifest>` vérifie que les URL répondent.
- `node tools/test-server.js <publish-out> [--port 8787] [--speed Ko/s] [--cut-after octets]` : serveur local pour répéter une mise à jour.
- `node test/e2e-dev.js` : test de bout en bout avec le vrai Electron en mode développement isolé (ouvre une fenêtre).
- Pas de linter ni de bundler (JS CommonJS brut).

### Mode développement isolé (jamais l'installation réelle)

Uniquement avec `npm start` (app non empaquetée) ET `COBBLEREALM_DEV=1` : `COBBLEREALM_ROOT` (dossier de jeu), `COBBLEREALM_MANIFEST_URL` (ex. `http://127.0.0.1:8787/manifest.json`). Ignorés dans l'application installée. Ajouter `-- --user-data-dir=<dossier temporaire>` pour isoler les réglages et la session Microsoft. **Définir `APPDATA` ne suffit PAS sous Windows** : Electron lit le vrai dossier Roaming via l'API système (`app.getPath("appData")`), donc sans `COBBLEREALM_ROOT` on travaille sur l'installation réelle `%APPDATA%\.cobblerealm`. Ne jamais cliquer JOUER / lancer `sync()` dans un test sans `COBBLEREALM_ROOT`.

## Architecture

Pas de dossier `src/` : tout est à la racine. **Tout nouveau fichier .js du processus principal doit être ajouté à `build.files` dans package.json**, sinon il manquera dans l'installeur.

- [main.js](main.js) : processus principal. Handlers IPC (via `handle()` qui vérifie l'origine), fenêtre (sandbox, CSP), séquence de lancement, vérification au démarrage.
- [updater/](updater/) : mise à jour du modpack par fichiers.
  - `manifest.js` : téléchargement + validation du manifest v2, liste blanche de domaines, validation des chemins (`resolveInside`).
  - `diff.js` : plan (à télécharger / adopter / retirer) par comparaison de contenu (SHA-256) et lock.json ; mode strict `mods/`, liste `remove`.
  - `download.js` : flux vers `.staging/<sha>.part`, reprise Range, 3 essais, vérification taille + SHA-256.
  - `apply.js` : déplacement vers le jeu, quarantaine `.removed/` (30 jours), `lock.json` écrit EN DERNIER.
  - `lock.js` : `lock.json` n'existe qu'entre deux mises à jour terminées (sinon `lock.prev.json` = indice, installation invalide).
  - `index.js` : `createUpdater()` → `check()`, `sync()`, `repair()`, `status()`. Hors-ligne autorisé seulement si l'installation est valide et le manifest jamais lu.
  - `http.js`, `errors.js` (messages joueur en français), `util.js`.
- [runtime.js](runtime.js) : Java >= version du manifest (runtime CobbleRealm, JAVA_HOME, PATH, sinon JRE Temurin téléchargé via l'API Adoptium, SHA-256 vérifié).
- [fabric.js](fabric.js) : profil Fabric selon `minecraft`/`fabricLoader` du manifest (régénéré si ils changent).
- [launcherUpdates.js](launcherUpdates.js) : auto-update du launcher (electron-updater, GitHub Releases), inactif en développement.
- [auth.js](auth.js), [minecraftAuth.js](minecraftAuth.js) : Microsoft (device code, cache chiffré `safeStorage`) puis Xbox → XSTS → Minecraft. `loginMicrosoft()` partage une seule connexion à la fois ; `cancelLogin()` annule immédiatement (MSAL arrêté via `request.cancel`, rien n'est enregistré).
- [playerErrors.js](playerErrors.js) : `describeError({step, error})` → message clair en français pour le joueur ({code, title, message, actions, severity}). Étapes : update, microsoft, minecraft-auth, java, fabric, launch, game-exit. Aucun détail technique dans le message.
- [serverStatus.js](serverStatus.js) : statut réel du serveur Minecraft (protocole Server List Ping, SRV). **`SERVER_ADDRESS` dans main.js est `null` tant que l'adresse n'est pas fournie : la ligne « Serveur » est alors masquée. Ne jamais mettre d'adresse inventée.** Une fois l'adresse renseignée, ajouter l'entrée correspondante au CHANGELOG.md.
- [changelog.js](changelog.js) : lit CHANGELOG.md (en ligne sur `main`, sinon cache, sinon version intégrée). Format imposé : `## Version x.y.z`, `### Nouveautés | Améliorations | Corrections`, `- élément`. Le test `test/infos.test.js` refuse les termes techniques dans le CHANGELOG.md.
- [support.js](support.js) : rapport de support (`buildReport`) et `sanitize()` : masque jetons, e-mail, pseudo, UUID, IP, chemins Windows avec nom d'utilisateur. **Tout texte destiné à un rapport ou affiché au joueur passe par `sanitize`.**
- [preload.js](preload.js) : pont `contextIsolation`. Tout nouveau canal IPC doit être déclaré dans main.js ET preload.js.
- [index.html](index.html) : renderer, HTML + CSS + JS inline (CSP : pas de ressource externe).
- [news.json](news.json) : annonces, lues sur `raw.githubusercontent.com/.../main/news.json`.
- [tools/](tools/) : outils administrateur (publication, serveur de test, `policy.json`). Hors installeur.
- `manifests/` : archive des manifests publiés (retour arrière). `docs/` : manifest servi par GitHub Pages.

### Flux de démarrage

Fenêtre → news → `updater.check()` (lecture seule, rien n'est téléchargé) → message de statut (« Mise à jour disponible — vX (N fichiers, Y Mo) », « CobbleRealm à jour », « Hors-ligne … »). Une seule requête du manifest par session ; l'interface réutilise le même résultat (`check-cobblerealm-update`).

### Flux de lancement (`launch-minecraft`)

1. `updater.sync()` (télécharge + applique). **Le jeu ne démarre jamais si cette étape échoue** : événement `launch-error` {code, title, message, actions, severity} + boutons Réessayer / Réparer. Hors-ligne avec installation valide : `update-warning` puis jeu sur la version installée.
2. Login Microsoft (device code affiché si session expirée) → `loginMinecraft`.
3. `ensureJava` + `ensureFabricProfile` avec les versions du manifest (sinon dernier lock.json, sinon valeurs de secours `FALLBACK_VERSIONS`).
4. `launcher.launch()` de MCLC. Écouteurs retirés à la fermeture du jeu.

Événements vers l'UI : `update-progress` (avec `etaSeconds`), `launch-error`, `update-warning`, `launcher-update-status`, `minecraft-status`, `minecraft-log`, `minecraft-progress`, `microsoft-device-code` (null = fermer), `launcher-self-update`.

### Règles du modpack

- Catégories (tools/policy.json) : `managed` (aligné sur le serveur, écrase), `default` (copié seulement s'il n'existe pas), `preserved` (jamais publié ni touché).
- On ne supprime que ce que `lock.json` indique comme installé. Tout retrait va en quarantaine `.removed/<date>/` (purgée après 30 jours, uniquement ce dossier). Fichiers inconnus hors `mods/` : jamais touchés.
- Mode strict `mods/` : tout `.jar` absent du manifest est mis en quarantaine (un mod en trop empêche de se connecter). Garde-fou : ignoré si le manifest ne contient aucun fichier dans ce dossier.
- `manifest.remove` : liste de fichiers exacts à retirer (ancienne liste `incompatibleMods`).
- Version du manifest : `schema: 2`. Comparaison par contenu, donc un retour à un ancien manifest fonctionne.

### Points importants

- Le nom du paquet (`cobblerealm-launcher`) et l'`appId` ne doivent PAS changer : le dossier `userData` (réglages, session Microsoft) et la mise à jour en place de l'installeur en dépendent.
- Tout le jeu vit dans `%APPDATA%/.cobblerealm`. Réglages du launcher dans `userData/settings.json`, RAM bornée par `clampRam` (2 Go min, max = RAM système − 2 Go, plafonné à 16).
- Les logs MCLC contiennent des tokens : toujours passer par `redactSecrets()` avant console/IPC, et `safeSend()` pour envoyer au renderer.
- Le manifest v2 est servi par GitHub Pages (`/docs`) ; les fichiers sont des assets de GitHub Releases du dépôt `cyrian290606/CobbleRealm-Pack` (à créer, voir `policy.json` > `hosting`). Les releases du launcher sont dans `CobbleRealm-Launcher`.
- Domaines autorisés pour les téléchargements : `github.com`, `*.githubusercontent.com` (redirections incluses) ; manifest : + `cyrian290606.github.io` ; Java : `api.adoptium.net` ; Fabric : `meta.fabricmc.net`.

### Incohérences connues

- Le [manifest.json](manifest.json) de `developpe` est une copie périmée de l'ANCIEN format (v1.0.5, ZIP `modpackV5`) : la référence réelle est celle de `origin/main` (v10, deux ZIP). Les anciens launchers (1.0.x) continuent à lire ce fichier sur `main` : ne pas le modifier avant d'avoir décidé de figer l'ancien système.
- Le dépôt local `main` a du retard sur `origin/main`. Une fusion future aura des conflits sur `main.js` (réécrit ici) et `manifest.json` (garder celui d'`origin/main`).
