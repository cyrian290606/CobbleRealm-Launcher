# Procédure de publication officielle de CobbleRealm Launcher 2.0

Chaque étape marquée **[AUTORISATION]** n'est exécutée qu'après un « oui » explicite de l'administrateur. Les autres sont en lecture seule.

## État de départ (à la rédaction)

| Élément | État |
|---|---|
| Code | branche `developpe` (local uniquement, **jamais envoyée sur GitHub**), dernier commit de code `ba90a06` (portait le numéro `13d1fb5` avant le nettoyage de l'historique : voir la correspondance ci-dessous), sauvegardée par `git bundle` dans `D:\Sauvegarde-CobbleRealm-avant-2.0\depot-git\` et `%USERPROFILE%\Sauvegarde-depot-git\` |
| Installeur | `dist\CobbleRealm-Launcher-Setup.exe`, identique octet pour octet au fichier du brouillon (SHA-256 `bfb2e508…58bc55`) ; son contenu = le code du commit `ba90a06` (28 fichiers sur 28 identiques, dépendances = `package-lock.json`) |
| Historique | **nettoyé avant publication** : le nom d'utilisateur Windows et deux UUID de joueurs réels ont été retirés de tous les commits locaux de `developpe` ; les numéros de commit ont changé (ex. `13d1fb5` → `ba90a06`, `7aba295` → `9aaacf0`), les fichiers sont identiques (même arbre Git). L'ancienne histoire n'est conservée que dans la sauvegarde `refs/original/refs/heads/developpe` et les fichiers `.bundle` (**ne jamais les pousser sur GitHub : pousser uniquement `developpe` et `fusion-2.0:main`**) |
| Release `v2.0.0` | **brouillon** invisible : installeur + `.blockmap` + `latest.yml` |
| Modpack V10 | en ligne et signé : https://cyrian290606.github.io/CobbleRealm-Pack/manifest.json |
| `main` (GitHub) | ancien launcher 1.0.x : `manifest.json` (v10, ZIP) et `news.json` intacts |
| `SERVER_ADDRESS` | volontairement vide (la ligne « Serveur » reste masquée) |

## Étape 0 — Avant tout (lecture seule)

1. Tester l'installeur du brouillon sur ton PC (installation par-dessus, JOUER, serveur). **Rien ne se publie avant ton « validé ».**
2. Lancer le contrôle complet : `node tools/preflight.js` → doit afficher « Tous les contrôles passent ».
3. Confirmer l'identifiant Azure (`tools/` n'y change rien : voir le compte rendu d'audit).

## Étape 1 — Publier la release du launcher **[AUTORISATION]**

Effet : `v2.0.0` devient publique et « Latest ». **C'est le moment où la mise à jour automatique des launchers 2.0 commence à fonctionner** et où le lien `releases/latest` donne l'installeur aux joueurs.

```powershell
$id = (gh api repos/cyrian290606/CobbleRealm-Launcher/releases --jq '.[] | select(.tag_name=="v2.0.0" and .draft) | .id')
gh api -X PATCH repos/cyrian290606/CobbleRealm-Launcher/releases/$id -F draft=false -f make_latest=true
```
(ou, dans l'interface GitHub : Releases → brouillon → **Publish release**, en laissant « Set as the latest release » coché.)

Vérification immédiate : `node tools/preflight.js --after` (télécharge l'installeur depuis le lien public et compare le SHA-256 ; vérifie que `latest.yml` est lisible).
**Retour arrière** : `gh api -X PATCH repos/cyrian290606/CobbleRealm-Launcher/releases/$id -F draft=true` (la release redevient invisible).

## Étape 2 — Sauvegarder `developpe` sur GitHub **[AUTORISATION]**

Effet : le code source du launcher 2.0 devient visible publiquement (le dépôt est public) ; aucun effet sur les joueurs. À faire avant la fusion pour que le travail existe ailleurs que sur ton PC.

```powershell
git push origin developpe
```

## Étape 3 — Fusionner `developpe` dans `main` **[AUTORISATION]**

Effet : `main` reçoit le code du launcher 2.0. **Les launchers 1.0.x ne sont pas affectés** : ils ne lisent que `manifest.json` et `news.json`, conservés tels quels. Le launcher 2.0 lira `news-2.json` (ajouté ici).

```powershell
git fetch origin
git switch -c fusion-2.0 origin/main
git merge --no-commit --no-ff developpe        # conflits attendus : index.html, main.js, manifest.json
git checkout developpe -- .                     # tout le code de developpe
git checkout origin/main -- manifest.json news.json   # ces deux fichiers restent ceux de main (anciens launchers)
copy tools\transition\news-2.json news-2.json   # annonces du launcher 2.0 (copie de l'annonce V10 actuelle)
git add -A
git diff --stat developpe                       # DOIT montrer seulement : manifest.json, news.json, news-2.json
node test/phase1.test.js                        # (et les autres suites : npm test)
git commit -m "Fusion de developpe : launcher 2.0"
git push origin fusion-2.0:main                 # [AUTORISATION] c'est ce push qui modifie main
```

Cette procédure a été **simulée** dans un clone temporaire : 3 conflits (index.html, main.js, manifest.json) résolus comme ci-dessus ; le résultat est identique à `developpe` sauf `manifest.json`, `news.json` et `news-2.json` ; les 14 suites de tests passent ; les fichiers embarqués dans l'installeur sont identiques.
**Retour arrière** : `git revert -m 1 <commit de fusion>` puis `git push origin main`.

## Étape 4 — Annoncer le passage à la 2.0 **[AUTORISATION]**

Effet : tous les joueurs 1.0.x voient l'annonce « installe la 2.0 à la main » dans leur launcher, et le message Discord les y invite.

1. Remplacer l'annonce des anciens launchers : `copy tools\transition\news.json news.json` sur `main`, commit, `git push origin main`.
2. Poster `tools/transition/ANNONCE-DISCORD.md` sur le Discord (à faire par toi).

**Retour arrière** : remettre l'ancien `news.json` (commit précédent).

## Étape 5 — Période de transition (2 à 4 semaines)

- Le modpack reste en v10 pour les deux systèmes ; **ne rien publier dans `CobbleRealm-Launcher` en dehors des releases du launcher** (une release « modpack » deviendrait « Latest » et casserait la mise à jour automatique).
- Les nouvelles versions du modpack passent par `CobbleRealm-Pack` (signées) : `tools/GITHUB-SETUP.md`, section « Publier une mise à jour du modpack ».

## Étape 6 — Premier test réel de la mise à jour automatique

Publier une version mineure du launcher (2.0.1) : `GH_TOKEN` + `npm run release` (brouillon), contrôle `node tools/preflight.js`, publication **[AUTORISATION]**, puis vérifier sur un PC avec la 2.0.0 que le bandeau « Nouvelle version prête » apparaît et que « Redémarrer maintenant » met à jour sans assistant. Test déjà réussi en laboratoire (installeur de test local).

## Ce qui ne sera jamais fait sans demande explicite

Push forcé, suppression d'une release ou d'un fichier de release, fusion dans `main`, publication de la release ou du modpack, modification de `SERVER_ADDRESS`, remplacement de l'identifiant Azure.
