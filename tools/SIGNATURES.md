# Signature du manifest : procédure d'administration

Document destiné à l'administrateur (hors installeur, hors dépôt public des joueurs). Il n'y figure aucune clé.

## Pourquoi

Le launcher exécute ce que le modpack lui fait installer (mods = du code). Si le compte GitHub ou GitHub Pages était
piraté, un manifest modifié pourrait distribuer un mod piégé à tous les joueurs. Le manifest est donc **signé hors
ligne** avec une clé privée que seul l'administrateur possède. Le launcher embarque les clés **publiques** et refuse :

- un manifest sans signature, avec une signature fausse ou tronquée ;
- un manifest modifié d'un seul octet après la signature ;
- un manifest signé par une clé inconnue ou révoquée ;
- tout manifest si aucune clé de confiance n'est configurée (jamais d'acceptation par défaut).

Quand la signature est refusée, **rien n'est téléchargé ni installé** et le launcher ne bascule pas en « mode
hors-ligne » : le jeu ne démarre pas sur une liste douteuse.

## Les deux clés

| Clé | Rôle | Où elle est |
|---|---|---|
| **Principale** | signe chaque publication | fichier chiffré + mot de passe, sur ton PC de publication et une copie hors ligne |
| **De secours** | prend le relais si la principale est perdue ou volée | fichier chiffré + mot de passe, **uniquement hors ligne**, séparée de la principale |

Les deux clés **publiques** sont dans `updater/trusted-keys.json` (dans le dépôt, c'est voulu : une clé publique ne
permet pas de signer). Le launcher accepte une signature de l'une ou l'autre, tant qu'elle n'est pas révoquée.

Les clés **privées** sont des fichiers `*.key.json` chiffrés (scrypt + AES-256-GCM). L'outil refuse de les écrire dans
le dépôt ou dans n'importe quel dossier Git, ne les écrase jamais, et `.gitignore` ignore `*.key.json`.

## 1. Génération (une seule fois)

1. Choisir un dossier **hors du dépôt**, par exemple `D:\CobbleRealm-Cles` (jamais dans OneDrive/Dropbox non chiffré).
2. Lancer :
   ```
   node tools/keys.js init --dir D:\CobbleRealm-Cles
   ```
   L'outil demande deux mots de passe **différents** (12 caractères minimum, saisie invisible) et crée
   `primary-<id>.key.json` et `backup-<id>.key.json`. Il écrit les clés publiques dans `updater/trusted-keys.json`.
3. `git add updater/trusted-keys.json` puis commit (la clé publique seulement). Vérifier : `node tools/keys.js check-repo`.
4. **Reconstruire le launcher** (`npm run build`) : tant que le launcher publié ne contient pas ces clés publiques, il
   refuse tous les manifests.

## 2. Sauvegarde (à faire tout de suite, avant la première publication)

- **Clé principale** : 1 copie sur le PC de publication + 1 copie hors ligne (clé USB rangée à part).
- **Clé de secours** : 2 copies **hors ligne** (clé USB + autre support), jamais sur le PC de publication.
- **Mots de passe** : dans un gestionnaire de mots de passe, **pas au même endroit** que les fichiers de clés.
- Test de restauration, une fois : copier un fichier de clé ailleurs et signer un manifest de test avec lui :
  `node tools/keys.js sign test.json --key <copie>.key.json`.
- Sans le fichier **et** le mot de passe, une clé est perdue définitivement : il n'existe aucune récupération.

## 3. Signer une publication

```
node tools/publish.js <dossierSource> --version x.y.z --sign D:\CobbleRealm-Cles\primary-<id>.key.json
```

Le mot de passe est demandé (ou variable `COBBLEREALM_KEY_PASSPHRASE` pour une automatisation sécurisée).
Résultat : `publish-out/docs/manifest.json` **et** `publish-out/docs/manifest.json.sig`. Les **deux** fichiers doivent
être copiés ensemble dans `docs/` du dépôt (GitHub Pages). La signature est archivée avec le manifest dans `manifests/`.

Vérification locale avant publication : `node tools/keys.js verify publish-out/docs/manifest.json`.

**Retour arrière** : remettre dans `docs/` un ancien `manifests/manifest-X.json` **et** son `.sig` (la signature reste
valable pour les mêmes octets).

## 4. Rotation planifiée de la clé principale (ex. une fois par an, ou changement de PC)

1. Générer la nouvelle clé : `node tools/keys.js new-key --role primary --dir D:\CobbleRealm-Cles`
   (la liste de confiance contient alors : ancienne principale + secours + nouvelle principale).
2. Publier une **nouvelle version du launcher** contenant cette liste (`npm run release`). Attendre que les joueurs
   l'aient reçue (mise à jour automatique) : laisser quelques semaines. Pendant ce temps, continuer à signer avec l'**ancienne** clé.
3. Passer à la nouvelle clé pour signer.
4. Publier une version du launcher qui **révoque** l'ancienne : `node tools/keys.js revoke <ancienId>` puis release.

Ne jamais signer avec une clé que les launchers des joueurs ne connaissent pas encore : ils refuseraient la publication.

## 5. Clé principale perdue (fichier ou mot de passe)

1. **Signer immédiatement avec la clé de secours** (`--sign ...backup-<id>.key.json`) : les launchers existants l'acceptent déjà.
2. Générer une nouvelle principale **et** une nouvelle secours (`new-key --role primary`, `new-key --role backup`).
3. Publier un launcher contenant la liste [secours actuelle, nouvelle principale, nouvelle secours] et révoquant la principale perdue.
4. Mettre à jour les sauvegardes (section 2).

## 6. Clé volée ou soupçonnée de l'être

Même procédure que la perte, **sans attendre** : tant que le launcher des joueurs n'a pas reçu la révocation, un
attaquant qui possède la clé et la main sur l'hébergement peut encore publier. La mise à jour du launcher passe par
GitHub Releases (`electron-updater`), un canal **distinct** de celui du modpack. Changer aussi les mots de passe du compte GitHub.

## 7. Limites (à connaître)

- Ce mécanisme protège le **modpack**. Il ne protège pas l'**installeur du launcher** lui-même (pas de certificat de
  signature de code Windows) : protéger le compte GitHub (double authentification) et le jeton `GH_TOKEN`.
- Un ancien manifest **validement signé** peut être republié par quelqu'un qui contrôle l'hébergement (retour arrière
  forcé vers une ancienne version signée). Une protection (refuser un manifest plus ancien que celui déjà installé) est
  possible mais empêcherait aussi tes retours arrière : non activée pour l'instant.
- Les launchers 1.0.x ne vérifient aucune signature (ils ignorent ce système).

## Commandes

```
node tools/keys.js init --dir <dossier>            clés principale + secours
node tools/keys.js new-key --role primary|backup --dir <dossier>
node tools/keys.js sign <manifest.json> --key <clé.key.json>
node tools/keys.js verify <manifest.json>
node tools/keys.js revoke <idClé>
node tools/keys.js status
node tools/keys.js check-repo                       aucune clé privée dans le dépôt ?
```

Mode test (développement isolé uniquement, ignoré par l'application installée) : `COBBLEREALM_TRUST_KEYS_FILE`
(clés de confiance de TEST) et `node tools/test-server.js <publish-out> --sign-key <clé de TEST>`. Ne jamais utiliser les vraies clés pour les tests.
