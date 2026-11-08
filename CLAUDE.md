# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Règle de branche (OBLIGATOIRE)

**Tout développement se fait sur la branche `developpe`.** Ne jamais travailler directement sur `main`, ne jamais fusionner `developpe` dans `main` ni pousser vers `main`/`origin` sans demande explicite de l'utilisateur. `main` est lue par les launchers déployés (manifest.json, news.json) : une erreur dessus touche tous les joueurs. Avant de commencer, vérifier avec `git branch --show-current` qu'on est bien sur `developpe`.

## Project

Launcher Electron (Windows uniquement, UI et logs en français) pour le modpack Minecraft **CobbleRealm** (Cobblemon, Minecraft 1.21.1 + Fabric). Il connecte le joueur via Microsoft, installe/met à jour le modpack et Java 21, puis lance le jeu avec `minecraft-launcher-core` (MCLC).

## Commandes

- `npm start` : lance l'app en dev (`electron .`).
- `npm run build` : crée l'installeur NSIS Windows dans `dist/` (electron-builder).
- `node test/phase1.test.js` : tests automatiques (faux Electron/MCLC/auth, sans réseau ni compte Microsoft).
- Il n'y a ni linter, ni étape de build du frontend (pas de bundler, JS CommonJS brut).
- Pour tester `npm start` sans toucher à l'installation réelle, définir `APPDATA` vers un dossier temporaire. Pour tester le build sans écraser `dist/` : `npm run build -- --config.directories.output=build-out`.

## Architecture

Pas de dossier `src/` : tout est à la racine.

- [main.js](main.js) (~2900 lignes) : processus principal. Contient tout : config, mise à jour du modpack, installation Java/Fabric, handlers IPC (`ipcMain.handle`), lancement du jeu, et la séquence de démarrage dans `app.whenReady`.
- [auth.js](auth.js) : OAuth Microsoft via `@azure/msal-node` (device code flow). Le cache de tokens est chiffré avec `safeStorage` dans `userData/microsoft-session.dat`.
- [minecraftAuth.js](minecraftAuth.js) : chaîne Xbox Live → XSTS → Minecraft Services (token + droits + profil), exposée par `loginMinecraft(msAccessToken, onLog)`.
- [preload.js](preload.js) : pont `contextIsolation` ; expose l'API IPC au renderer. Tout nouveau canal IPC doit être déclaré à la fois dans main.js et preload.js.
- [index.html](index.html) (~2700 lignes) : renderer, HTML + CSS + JS inline dans un seul fichier. `nodeIntegration` est désactivé.
- [manifest.json](manifest.json) et [news.json](news.json) : fichiers **distants**, lus depuis `raw.githubusercontent.com/cyrian290606/CobbleRealm-Launcher/main/` (branche `main`), pas depuis le disque. Les modifier et pousser sur `main` met à jour tous les launchers déployés.

### Flux de démarrage (`app.whenReady`)

1. Ouvre la fenêtre, attend `did-finish-load`.
2. Charge les news (avec fallback `getDefaultLauncherNews()` ; `normalizeLauncherNews` accepte plusieurs formes de JSON).
3. Compare `~/AppData/Roaming/.cobblerealm/version.json` à `manifest.version` (`compareVersions`, semver numérique).
4. Si MAJ : télécharge chaque ZIP de `manifest.downloads[]`, valide tous les ZIP en extraction temporaire, sauvegarde `options.txt`/`optionsof.txt`/`servers.dat`, **supprime** les dossiers synchronisés (`mods`, `config`, `resourcepacks`, etc. : liste `foldersToSync`), extrait, restaure les fichiers joueur, retire les mods de `incompatibleMods`, puis écrit `version.json`.
5. Envoie l'état au renderer via le canal `launcher-update-status` (`checking`/`downloading`/`download-progress`/`installing`/`install-progress`/`ready`/`error`). Le bouton JOUER reste bloqué tant que le statut n'est pas `ready`.

### Flux de lancement (`launch-minecraft`)

Login Microsoft (device code si session expirée) → `loginMinecraft` → `ensureJava21` (JRE Adoptium téléchargé dans `.cobblerealm/runtime/java21`) → `ensureFabricProfile` (profil JSON Fabric de meta.fabricmc.net, écrit dans `.cobblerealm/versions/`) → `launcher.launch()` de MCLC avec `version.custom` = profil Fabric. Retours vers l'UI via `minecraft-status`, `minecraft-log`, `minecraft-progress`, `microsoft-device-code`.

### Points importants

- Versions codées en dur dans main.js : `MINECRAFT_VERSION` (1.21.1), `FABRIC_LOADER_VERSION`, `JAVA_21_URL`. Le client ID Azure est dans auth.js.
- Tout le jeu vit dans `%APPDATA%/.cobblerealm`. Les réglages du launcher (`ram`) sont dans `userData/settings.json`, bornés par `clampRam` (2 Go min, max = RAM système − 2 Go, plafonné à 16).
- Les logs MCLC contiennent des tokens : toujours passer par `redactSecrets()` avant console/IPC, et utiliser `safeSend()` pour envoyer au renderer (fenêtre possiblement détruite).
- Pour publier une nouvelle version du modpack : mettre à jour `version` et `downloads` dans [manifest.json](manifest.json) et le pousser sur `main`. La version du launcher lui-même est dans `package.json` (indépendante).

### Incohérences connues (vérifier avant de s'y fier)

- Le [manifest.json](manifest.json) de `developpe` est une copie périmée (v1.0.5, ZIP `modpackV5`) : la référence réelle est celle de `origin/main` (v10, deux ZIP). Le format attendu par main.js est `downloads` (tableau).
- Le dépôt local `main` a du retard sur `origin/main` (manifest v10 en ligne, extraction ZIP réécrite). Une fusion future aura des conflits sur `main.js` et `manifest.json` : pour `manifest.json`, garder la version d'`origin/main`.
