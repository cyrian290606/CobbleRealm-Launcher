# Mise en place de CobbleRealm-Pack (GitHub Pages + GitHub Releases)

Guide administrateur. **Rien n'est publié tant que tu n'as pas exécuté toi-même les étapes marquées « GitHub ».**
Les étapes marquées « local » ne touchent que ton PC.

## Vue d'ensemble

| Quoi | Où | Contenu |
|---|---|---|
| Le manifest + sa signature | **GitHub Pages** du dépôt `CobbleRealm-Pack` (`/docs`) | `manifest.json`, `manifest.json.sig` (quelques centaines de Ko) |
| Les fichiers du modpack | **Releases** `pack-files-1`, `pack-files-2`… du dépôt `CobbleRealm-Pack` | 52 bundles + ~640 fichiers volumineux (3,2 Go), nommés par leur SHA-256 |
| L'archive des manifests | dossier `manifests/` du dépôt Pack | retour arrière |
| Le launcher | Releases du dépôt `CobbleRealm-Launcher` | installeur + mise à jour automatique |

Adresse lue par le launcher : `https://cyrian290606.github.io/CobbleRealm-Pack/manifest.json`.
Le dépôt `CobbleRealm-Launcher` (et sa branche `main`, lue par les anciens launchers 1.0.x) **n'est pas touché**.

## Avant de commencer (une seule fois)

- Compte GitHub avec la **double authentification activée** (Paramètres → Password and authentication). C'est la protection principale de tout le système.
- Installer le CLI GitHub : https://cli.github.com puis `gh auth login` (navigateur, compte `cyrian290606`).
- Git pour Windows installé.

## Étape 1 (local) : préparer le dépôt Pack sur ton PC

```powershell
cd "D:\video et tout ci tout ca\Travail\Desktop\CobbleRealm-Launcher"
node tools/pack-prepare.js D:\CobbleRealm-Pack
```

Crée le dossier `D:\CobbleRealm-Pack` (README, `.gitattributes` qui interdit toute modification des octets, `.gitignore`, `docs/`, `manifests/`) avec un Git **local**, sans aucun dépôt distant. Il refuse un dossier non vide.

## Étape 2 (GitHub) : créer le dépôt

1. https://github.com/new — propriétaire `cyrian290606`, nom **`CobbleRealm-Pack`**.
2. **Public** (obligatoire : les joueurs téléchargent sans compte, et GitHub Pages gratuit exige un dépôt public).
3. **Ne coche rien** (ni README, ni .gitignore, ni licence) : le dépôt doit être vide.
4. Settings → Branches (ou Rules) : activer la protection de la branche `main` (interdire la suppression et le force-push).

## Étape 3 (GitHub) : relier et envoyer la structure (quelques Ko)

```powershell
cd D:\CobbleRealm-Pack
git remote add origin https://github.com/cyrian290606/CobbleRealm-Pack.git
git push -u origin main
```

## Étape 4 (GitHub) : activer GitHub Pages

Dépôt → Settings → Pages → *Build and deployment* → Source : **Deploy from a branch** → Branch **main**, dossier **/docs** → Save.
L'adresse devient `https://cyrian290606.github.io/CobbleRealm-Pack/`. (Sans manifest, `/manifest.json` répondra 404 : normal.)

## Étape 5 (local) : préparer la première publication signée

Prérequis : dossier source du modpack **sans** les 3 anciens mods en double (ForgeConfigAPIPort 21.1.4, architectury 13.0.8, cobblemon_quests 1.1.14 : l'outil refuse de publier s'ils y sont).

```powershell
cd "D:\video et tout ci tout ca\Travail\Desktop\CobbleRealm-Launcher"
node tools/publish.js "<TON DOSSIER SOURCE>" --version 10.0.0 --pack D:\CobbleRealm-Pack --sign "<chemin de la clé PRINCIPALE>\primary-76a0d12e12b40b44.key.json" --write-docs
```

- Le mot de passe de la clé principale est demandé (invisible).
- Résultat dans `D:\CobbleRealm-Pack` : `docs/manifest.json` + `docs/manifest.json.sig`, `manifests/manifest-10.0.0.json(.sig)`, et `publish-out/release-pack-files-1/` (les ~690 fichiers à envoyer, **ignorés par Git**) + `publish-out/UPLOAD.md`.
- Rien n'est envoyé. Contrôle d'abord : `node tools/publish.js --check D:\CobbleRealm-Pack\docs\manifest.json --signature-only` doit afficher « Signature valide ».

## Étape 6 (GitHub) : envoyer les fichiers dans la release

```powershell
node tools/upload-release.js D:\CobbleRealm-Pack\publish-out\release-pack-files-1 --tag pack-files-1 --repo cyrian290606/CobbleRealm-Pack --create --dry-run
node tools/upload-release.js D:\CobbleRealm-Pack\publish-out\release-pack-files-1 --tag pack-files-1 --repo cyrian290606/CobbleRealm-Pack --create
```

- Le premier est une simulation (rien n'est envoyé). Le second envoie par lots de 20, 3 Go au total (compte 20 à 60 minutes selon ta connexion montante).
- **Si ça s'interrompt, relance exactement la même commande** : ce qui est déjà en ligne n'est pas renvoyé. Il n'écrase et ne supprime jamais rien.
- À la fin : « OK : N fichier(s) en ligne, tailles vérifiées ».

## Étape 7 (local, puis GitHub) : vérifier que tout est en ligne AVANT de publier le manifest

```powershell
node tools/publish.js --check D:\CobbleRealm-Pack\docs\manifest.json
```

Doit afficher « Signature valide », puis « Toutes les URL répondent » (une requête par fichier de la release).
**Ne passe pas à l'étape suivante autrement.**

## Étape 8 (GitHub) : publier le manifest

```powershell
cd D:\CobbleRealm-Pack
git add docs manifests
git commit -m "Publication 10.0.0"
git push
```

Attendre 1 à 2 minutes, puis contrôler la version EN LIGNE :

```powershell
cd "D:\video et tout ci tout ca\Travail\Desktop\CobbleRealm-Launcher"
node tools/publish.js --check https://cyrian290606.github.io/CobbleRealm-Pack/manifest.json --signature-only
```

## Étape 9 : test réel avant d'annoncer

Dans l'environnement isolé (`COBBLEREALM_ROOT`, `--user-data-dir`), lancer le launcher avec `COBBLEREALM_MANIFEST_URL` réglé sur l'adresse en ligne et tes **vraies** clés publiques (déjà intégrées au launcher) : installation complète, JOUER, jeu qui démarre. Seulement ensuite, publier le launcher 2.0 (`npm run release`, avec `GH_TOKEN`).

## Publier une mise à jour du modpack (routine)

1. Modifier le dossier source (jamais le dépôt Pack).
2. `node tools/publish.js "<source>" --version 10.0.1 --pack D:\CobbleRealm-Pack --sign "<clé principale>" --write-docs`
3. `node tools/upload-release.js` avec la commande indiquée dans `publish-out/UPLOAD.md` (seuls les **nouveaux** fichiers sont envoyés ; la release « ouverte » reçoit les nouveautés, une nouvelle est créée à 900 fichiers).
4. `node tools/publish.js --check D:\CobbleRealm-Pack\docs\manifest.json` puis `git add docs manifests`, `commit`, `push`.

## Retour arrière

Dans `D:\CobbleRealm-Pack` : remplacer `docs/manifest.json` et `docs/manifest.json.sig` par `manifests/manifest-X.json` et `manifests/manifest-X.json.sig` (copiés puis renommés), `git commit`, `git push`. Les anciens fichiers sont toujours dans les releases : les joueurs reviennent à l'ancienne version.

## Règles de sécurité

- **Jamais** de clé privée, de jeton ni de mot de passe dans le dépôt Pack (le `.gitignore` bloque `*.key.json`, `*.pem`).
- **Jamais** supprimer ni remplacer un fichier d'une release.
- **Jamais** modifier `docs/manifest.json` à la main (la signature serait invalide : plus aucune mise à jour possible).
- Sauvegardes des clés : voir `tools/SIGNATURES.md`.

## En cas de problème

| Symptôme | Cause probable |
|---|---|
| Le launcher affiche « La liste de mise à jour n'a pas pu être vérifiée » | `manifest.json.sig` absent, ou manifest modifié, ou clé non connue du launcher : refaire `--check ... --signature-only` |
| Le launcher affiche « Le serveur de mise à jour est momentanément inaccessible » | GitHub Pages pas encore actif (étape 4) ou manifest pas encore poussé (étape 8) |
| `upload-release` s'arrête avec « 502 » | GitHub limite le débit : relancer la même commande plus tard |
| `publish.js` refuse « est aussi publié » | un des 3 anciens mods en double est dans le dossier source |

## Publier le launcher lui-même (mise à jour automatique des joueurs)

Le launcher se met à jour via les Releases du dépôt `CobbleRealm-Launcher` (electron-updater). Il lit la **dernière release non pré-version**, y cherche `latest.yml`, compare la version, télécharge l'installeur (par différences grâce au `.blockmap`) et l'installe à la fermeture ou au clic sur « Redémarrer maintenant » (installation silencieuse, puis relance).

**Pièges à connaître (vérifiés) :**

- La « dernière release » est la **plus récente par date**. Aujourd'hui c'est une ancienne release du modpack (`v10`, sans `latest.yml`) : tant qu'une release du launcher n'est pas publiée après elle, la vérification échoue en silence (aucun joueur ne le voit, mais aucune mise à jour n'arrive).
- **Ne jamais créer de release « modpack » dans `CobbleRealm-Launcher` après une release du launcher** : elle deviendrait la « dernière » et casserait les mises à jour du launcher pour tous les joueurs. Les fichiers du modpack vont dans `CobbleRealm-Pack`. Si l'ancien système (launchers 1.0.x) doit encore être alimenté, ses releases doivent être marquées **pre-release** (elles sont alors ignorées).
- Les versions du launcher suivent `package.json` (`2.0.0`, `2.0.1`...) et le tag de la release doit être `v2.0.0`, `v2.0.1`...

**Procédure (avec ton autorisation à chaque étape) :**

1. Mettre `version` à jour dans `package.json` et une nouvelle section dans `CHANGELOG.md`.
2. `npm test` doit être entièrement vert.
3. Avec `GH_TOKEN` défini (jeton ayant la permission « Contents: write » sur `CobbleRealm-Launcher` seulement) : `npm run release`. La release est créée en **brouillon** (`draft`) : personne ne la voit.
4. Sur GitHub (Releases → brouillon), vérifier la présence de `CobbleRealm-Launcher-Setup.exe`, de `CobbleRealm-Launcher-Setup.exe.blockmap` et de `latest.yml`, puis **Publier**.
5. Vérifier : `node -e "fetch('https://github.com/cyrian290606/CobbleRealm-Launcher/releases/latest/download/latest.yml').then(r=>r.text()).then(console.log)"` doit afficher la nouvelle version.

**Nouveau joueur :** il télécharge `CobbleRealm-Launcher-Setup.exe` depuis la page de la release (Windows SmartScreen affichera un avertissement tant que l'installeur n'est pas signé avec un certificat : « Informations complémentaires » puis « Exécuter quand même »).
