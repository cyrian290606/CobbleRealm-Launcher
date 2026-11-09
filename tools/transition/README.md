# Transition des joueurs 1.0.x vers le launcher 2.0

Les launchers 1.0.x n'ont **aucun** mécanisme de mise à jour d'eux-mêmes : ils doivent installer la 2.0 **à la main, une seule fois** (l'installeur 2.0 se pose par-dessus : même application, mêmes raccourcis, mêmes réglages). Ensuite, tout est automatique.

## Ce qui existe

| Fichier | Rôle |
|---|---|
| `tools/transition/news.json` | Annonce affichée par les **anciens** launchers (carte « actualités » de l'accueil). Texte seul : l'ancien launcher n'a pas de lien cliquable, donc l'adresse de téléchargement est écrite en toutes lettres. |
| `tools/transition/ANNONCE-DISCORD.md` | Message à poster sur le Discord (étapes pour les joueurs). |
| `news-2.json` (racine, à placer sur `main`) | Annonces affichées par le launcher **2.0** (il lit `news-2.json`, plus `news.json`) : les joueurs 2.0 ne voient donc jamais l'annonce de transition. |

Les launchers 1.0.x continuent à lire `manifest.json` et `news.json` sur la branche `main` du dépôt `CobbleRealm-Launcher` : **ces deux fichiers doivent rester en place** (modpack v10 figé) tant qu'il reste des joueurs en 1.0.x.

## Ordre des opérations (chaque étape demande ton autorisation)

1. **Publier la release `v2.0.0`** du launcher (brouillon → vérifier → Publier), puis contrôler que c'est bien la release « Latest » (`gh api repos/cyrian290606/CobbleRealm-Launcher/releases/latest --jq .tag_name` doit afficher `v2.0.0`).
2. **Poster l'annonce Discord** (`ANNONCE-DISCORD.md`). Le lien `releases/latest` pointe alors vers l'installeur 2.0.
3. **Mettre l'annonce dans les anciens launchers** : sur la branche `main`, remplacer `news.json` par `tools/transition/news.json` et ajouter `news-2.json` (annonce normale du launcher 2.0, voir plus bas). Commit + push sur `main` (c'est le seul fichier qui touche les anciens launchers : `manifest.json` reste inchangé).
4. **Laisser une période de transition** (par exemple 2 à 4 semaines), pendant laquelle le modpack **reste en v10** (l'ancien système n'est plus alimenté).
5. **Après la transition** : publier les nouvelles versions du modpack uniquement via `CobbleRealm-Pack` (v11…). Les joueurs restés en 1.0.x resteront en v10 et ne pourront plus se connecter si le serveur exige v11 : leur annonce les invite à installer la 2.0.

## Règles importantes

- **Ne plus créer de release de modpack dans `CobbleRealm-Launcher`.** La mise à jour automatique du launcher lit la release « Latest » de ce dépôt : une nouvelle release de modpack deviendrait « Latest » et casserait les mises à jour du launcher pour tout le monde. Si une release non-launcher est vraiment nécessaire : la marquer **pre-release** (ignorée), ou créer avec `--latest=false`.
- Les anciennes releases (modpack v5 à v10, anciens installeurs 1.0.x) peuvent rester : elles sont plus anciennes que la `v2.0.0` donc sans effet.
- La fusion `developpe` → `main` demande de **garder les `manifest.json` et `news.json` de `main`** (ceux de `developpe` sont périmés) puis d'appliquer l'étape 3.

## `news-2.json` initial

Copie de l'annonce actuelle de `main` (« Bienvenue sur CobbleRealm, mise à jour V10 »), à placer à la racine de `main` sous le nom `news-2.json`. Tant que ce fichier n'existe pas, le launcher 2.0 affiche une annonce neutre (aucune erreur).
