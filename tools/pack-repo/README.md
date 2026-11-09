# CobbleRealm-Pack

Dépôt de **distribution** du modpack CobbleRealm. Il est lu automatiquement par le launcher : **ne rien modifier à la main**.

| Élément | Rôle |
|---|---|
| `docs/manifest.json` | liste de tous les fichiers du modpack (versions, empreintes SHA-256, adresses) |
| `docs/manifest.json.sig` | **signature** de la liste : le launcher refuse toute liste sans signature valide |
| Releases `pack-files-1`, `pack-files-2`… | les fichiers du modpack, nommés par leur empreinte SHA-256 |
| `manifests/` | archive de chaque manifest publié (retour arrière) |

`docs/` est servi par GitHub Pages à l'adresse `https://cyrian290606.github.io/CobbleRealm-Pack/manifest.json`.

## Règles

- **Ne jamais supprimer** un fichier d'une release : les anciennes versions du modpack et les retours arrière en ont besoin.
- **Ne jamais éditer** `docs/manifest.json` à la main : la signature deviendrait invalide et plus aucun joueur ne pourrait se mettre à jour.
- Aucune clé privée, aucun jeton dans ce dépôt (jamais).
- Les publications se font avec les outils du dépôt `CobbleRealm-Launcher` (`tools/publish.js`) ; voir `tools/GITHUB-SETUP.md` de ce dépôt.
