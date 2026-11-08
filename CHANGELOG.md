# Nouveautés du launcher CobbleRealm

Ce fichier présente, version après version, ce qui change pour les joueurs.

---

## Version 2.0.0

### Nouveautés
- Nouveau système de mise à jour : le launcher ne télécharge plus que les fichiers qui ont changé, au lieu de tout retélécharger.
- Si tu as déjà CobbleRealm installé, tes fichiers sont reconnus : il n'est pas nécessaire de tout retélécharger.
- Nouveau bouton « Réparer l'installation » : il retrouve et remplace les fichiers manquants ou abîmés.
- Nouveau bouton « Réessayer » quand une mise à jour échoue.
- Suivi du téléchargement plus complet : barre de progression, fichier en cours, nombre de fichiers et vitesse.
- Si tu n'as pas de connexion Internet, tu peux lancer la version déjà installée (avec un avertissement).
- Le launcher se met désormais à jour tout seul.
- La page Changelog affiche maintenant les vraies nouveautés du launcher, mises à jour en ligne sans avoir à réinstaller. Sans connexion, la dernière version connue ou celle intégrée au launcher s'affiche.
- La page Paramètres est complète : mémoire (RAM) avec la valeur recommandée mise en avant et un avertissement utile, ouverture du dossier du jeu, réparation de l'installation en un clic, taille de l'interface, rappel des raccourcis clavier et informations de version.
- Le launcher peut se réduire pendant que tu joues et revient tout seul quand Minecraft se ferme (réglage « Pendant la partie »).
- Bouton « Copier les informations » dans « À propos » pour faciliter l'aide de l'équipe, sans donnée personnelle.
- Console plus lisible : chaque message est horodaté et coloré selon sa gravité (avertissements en jaune, erreurs en rouge), avec un filtre « Avertissements et erreurs ».
- Nouveaux boutons dans la console : « Copier » et « Exporter » enregistrent le journal pour l'envoyer à l'équipe (sans donnée personnelle), « Effacer » le vide.
- Animations discrètes et fluides : les pages apparaissent en fondu, les fenêtres et les menus s'ouvrent en douceur, le bouton JOUER « respire » doucement quand tout est prêt et un reflet parcourt la barre de téléchargement.
- Nouvelle option « Réduire les animations » dans les Paramètres. Par défaut, le launcher suit le réglage de Windows.
- Le launcher se souvient de la taille et de la position de sa fenêtre : tu la retrouves comme tu l'avais laissée. Si l'écran a changé, elle revient toujours à un endroit visible.
- Notifications Windows : quand le launcher n'est pas au premier plan, tu es prévenu si une erreur survient, quand Minecraft est lancé ou quand une nouvelle version du launcher est prête. Un clic ramène le launcher. Elles se désactivent dans les Paramètres.
- Le temps restant estimé s'affiche pendant les téléchargements.
- Tu peux annuler un téléchargement : ce qui est déjà reçu est conservé, et il reprend ensuite sans tout recommencer.
- Nouveau menu du compte Microsoft : tu peux changer de compte ou te déconnecter depuis le launcher.
- Fenêtre de connexion Microsoft plus complète : boutons pour copier le code, rouvrir la page ou annuler, avec le temps restant avant l'expiration du code.

### Améliorations
- La mise à jour se termine toujours avant le lancement du jeu : plus de risque de démarrer avec une installation à moitié à jour.
- Tes réglages et fichiers personnels (options, sauvegardes, captures d'écran, shaders) ne sont plus touchés par les mises à jour.
- Les mods qui ne font plus partie de CobbleRealm sont retirés automatiquement, et gardés de côté pendant 30 jours au cas où.
- La mémoire proposée (RAM) s'adapte à la puissance de ton ordinateur, avec une valeur de départ raisonnable.
- Messages d'erreur plus clairs, en français, qui t'expliquent quoi faire.
- Installation plus légère : le fichier d'installation du launcher est beaucoup plus petit.
- Sécurité renforcée.
- Les listes de mise à jour du modpack sont maintenant protégées par une signature : si elles ont été modifiées par quelqu'un d'autre que l'équipe CobbleRealm, le launcher les refuse et n'installe rien.
- Quand une erreur survient, un message clair en français explique ce qui s'est passé, avec des boutons adaptés : Réessayer, Réparer l'installation, Copier le rapport ou Obtenir de l'aide.
- Le bouton « Copier le rapport » prépare un résumé à envoyer à l'équipe en cas de problème, sans aucune information personnelle (compte, pseudo, mots de passe ou nom de ton ordinateur).
- Tu es maintenant prévenu si Minecraft s'arrête à cause d'une erreur.
- Le bouton JOUER indique clairement l'état : « METTRE À JOUR ET JOUER » quand une mise à jour est disponible, « EN JEU » quand Minecraft est lancé, avec un indicateur de chargement animé à la place de l'ancien sablier.
- Les textes du bouton JOUER s'adaptent à sa taille : plus de message coupé, même sur une petite fenêtre.
- L'interface s'adapte automatiquement aux grands écrans : textes, boutons et fenêtres grandissent avec la taille de la fenêtre, sans changer l'apparence du launcher.
- Les plus petits textes (pastilles, détails, indications) sont un peu plus grands pour être plus faciles à lire.
- Les versions affichées (launcher, Minecraft, Fabric et modpack) sont celles réellement installées sur ton ordinateur.
- Pendant le chargement, l'annonce affiche un cadre d'attente ; sans Internet, la dernière annonce connue s'affiche.
- La zone de téléchargement est plus claire : pourcentage, temps restant, fichier en cours, nombre de fichiers, volume et vitesse.
- La zone du bouton JOUER garde une taille stable quand un téléchargement, un avertissement ou un message s'affiche : le bouton ne bouge plus.
- Le message « nouvelle version du launcher prête » s'affiche dans la barre de gauche, avec un bouton pour redémarrer.
- Quand tu n'es pas connecté, le compte s'affiche en gris avec une indication claire pour te connecter (il apparaissait en vert, comme si tout allait bien).
- Le launcher s'utilise entièrement au clavier : Tab pour passer d'un élément à l'autre, avec un contour bien visible sur l'élément sélectionné, Entrée ou Espace pour valider, Échap pour fermer une fenêtre.
- Raccourcis clavier : Alt+1 à Alt+4 pour changer de page (Accueil, Changelog, Console, Paramètres) et Ctrl+Entrée pour lancer le jeu.
- Le compte Microsoft et la fenêtre de connexion peuvent s'utiliser au clavier (Entrée, flèches, Tab, Échap).
- L'annonce s'adapte à la taille de ta fenêtre : sur une petite fenêtre, elle se réduit et un bouton « Lire la suite » affiche le texte complet.

### Corrections
- Sur les petites fenêtres, le titre CobbleRealm n'est plus coupé et l'annonce ne recouvre plus le bouton JOUER.
- L'installation de Java ou d'un mod pouvait échouer à cause de l'antivirus Windows, qui bloque parfois un fichier pendant un instant : le launcher réessaie maintenant automatiquement.
- L'indicateur « Serveur EN LIGNE » s'affichait toujours, même quand le serveur était éteint : il n'apparaît plus tant que l'état réel du serveur n'est pas connu.
- Après une partie, le launcher proposait parfois une mise à jour (ou retéléchargeait de petits fichiers) alors que rien n'avait changé : certains mods réécrivent simplement leur fichier de réglages à chaque démarrage. C'est corrigé.
- La première installation du modpack s'arrêtait avec « Une erreur inattendue est survenue » à cause de certains fichiers vides : c'est corrigé.
- Une ancienne annonce (« V4 ») pouvait s'afficher brièvement au démarrage : c'est corrigé.
- Il n'était pas possible d'annuler une connexion Microsoft en cours : c'est désormais possible à tout moment.
- Un message de développement incompréhensible (« APPID EN ATTENTE ») qui pouvait s'afficher sur le bouton JOUER a été supprimé : il est remplacé par une explication claire.
- Le bouton JOUER redevient utilisable immédiatement après une erreur, sans attendre quelques secondes.
- Le code de connexion Microsoft s'affiche maintenant aussi quand il faut te reconnecter au moment de jouer.
- Les messages de la console ne s'affichent plus en double après plusieurs lancements.
- Impossible d'ouvrir le launcher plusieurs fois en même temps : la fenêtre déjà ouverte revient au premier plan.
