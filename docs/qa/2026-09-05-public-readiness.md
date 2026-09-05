# Sub Rosa : préparation à la diffusion, 5 septembre 2026

Cette passe rend le catalogue créatif plus accessible, corrige les reprises de
session et ferme les lacunes de traduction repérées sur les deux interfaces.
Elle ne constitue pas une certification de sortie : les générations payantes,
les paquets signés et le partage sur iPhone physique restent à éprouver.

## Comportements livrés

- Le Studio propose six points de départ : image, vidéo, narration, musique,
  bruitage et film. Les compteurs proviennent du catalogue chargé. Les ateliers
  et le dernier onglet choisi restent accessibles.
- Le choix du modèle devient une recherche dans le catalogue, avec les noms,
  variantes, contraintes et voix publiées. Un tarif inconnu reste inconnu ;
  un modèle explicitement hors ligne n’est pas réintroduit par le secours.
- Les écrans chargés à la demande et le démarrage proposent une reprise
  explicite. Un échec de chargement des notes ne se présente plus comme une
  bibliothèque vide. La première note n’est pas créée deux fois par StrictMode.
- Sur mobile, un échec d’envoi conserve le brouillon et les pièces jointes.
  Une ancienne réponse ne remplace plus l’état d’un nouveau tour. Une reprise
  native prend une propriété exclusive sur le tour et revérifie la ligne avant
  d’appeler le modèle. Après un redémarrage ayant perdu les pièces jointes, la
  session demande de les joindre à nouveau avant tout appel payant.
- Le contrôle de traduction couvre les branches conditionnelles, les chaînes
  de repli, les gabarits, le JSX et ses attributs dans tous les TSX livrés.
  L’audit a aussi corrigé des messages indirects de chat, de réglages et de
  mobile. Les exemples techniques restent des données. Ce contrôle syntaxique
  ne prouve pas à lui seul la traduction de toutes les fonctions auxiliaires.
- La politique de confidentialité explicite du catalogue prévaut sur les
  métadonnées contradictoires. Les descriptions attribuent les politiques au
  catalogue, sans promettre un chiffrement côté client non vérifié.
- Les deux cibles iOS ont l’App Group dans leurs entitlements et dans la
  configuration de génération XcodeGen. Le partage conserve ainsi son accès
  au même conteneur après régénération du projet.

## Vérifications

| Contrôle | Résultat |
| --- | --- |
| Vitest, `--maxWorkers=2` | 249 suites, 4 087 tests réussis, 2 ignorés |
| TypeScript et build Vite | Réussis ; avertissement de taille du chunk App conservé |
| Biome et son ratchet | Réussis ; 627 avertissements existants, contre 631 au départ |
| Rust natif, `cargo test --all-targets` | 981 tests réussis, 1 ignoré |
| Rust natif, `cargo clippy --all-targets -- -D warnings` | Réussi |
| iOS appareil et simulateur, `cargo check --lib` | Réussis ; 9 avertissements mobiles existants |
| Entitlements | XML valide ; tests du groupe partagé et des deux cibles XcodeGen réussis |
| `pnpm audit --prod` | Aucune vulnérabilité signalée pour les 102 dépendances analysées |
| `cargo audit` des deux lockfiles | Aucun avis bloquant selon la politique existante ; exception RSA documentée conservée, 16 avis de maintenance et 1 avis de sûreté côté natif |

Les dépendances et les seuils d’avertissement n’ont pas été modifiés. La seule
exception de taille retirée est celle de Sidebar, redevenu inférieur à 2 000
lignes après extraction de ses menus. Les assertions de confidentialité ont
été ajustées pour refuser l’ancienne priorité donnée aux métadonnées.

## Vérification visuelle

Parcours dans les vrais composants React du Studio, avec un pont Tauri de test
et un instantané du catalogue public Carpe Diem du jour. Aucune génération
payante, aucune donnée personnelle ni clé dans ces captures. Le pont refuse
les commandes de génération ; ce parcours ne valide donc ni la facturation,
ni la qualité des modèles, ni le téléchargement d’un résultat réel.

Le parcours ouvre l’image, recherche Flux, ferme le choix au clavier, ouvre
directement la narration, recherche et choisit une famille vidéo, bascule le
thème et la largeur, puis provoque un échec de chargement et le reprend.
Aucune erreur JavaScript inattendue. Les captures ont été inspectées après
les animations d’ouverture.

![Studio en français, thème clair](evidence/2026-09-05-readiness/studio-light.png)

![Recherche et choix d’un modèle](evidence/2026-09-05-readiness/model-picker-light.png)

![Reprise après un échec de chargement simulé](evidence/2026-09-05-readiness/startup-recovery.png)

![Studio dans une fenêtre étroite, thème sombre](evidence/2026-09-05-readiness/studio-narrow.png)

## Ce qui conditionne encore une sortie

1. Réaliser un essai payant borné : chat avec outils, image, voix, vidéo,
   reprise après suspension, téléchargement et débit constaté. Le budget
   d’essai a été demandé ; aucun crédit n’a été dépensé pendant cette passe.
2. Produire et installer les paquets macOS signés, le paquet Windows et la version iOS
   sur appareil physique. Vérifier les mises à jour, les permissions audio et
   le partage depuis une autre application. Les compilations ne remplacent
   pas ces essais. Les deux profils iOS doivent autoriser l’App Group ; les
   étapes et secrets requis restent décrits dans `HANDOFF.md`.
3. Confirmer les droits de redistribution des cinq polices déjà présentes
   dans `public/`. La provenance de leur licence n’est pas documentée dans
   ce dépôt ; cela ne démontre pas une absence de licence.

Cette branche ne nécessite aucun déploiement d’un backend hébergé. Elle ne
publie pas de version et ne modifie pas les données de l’installation locale.
