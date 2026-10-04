import type { Copy } from "../pages/docs-content";

/** "Understanding models": the vocabulary every catalog page links to, so a
 * score or a spec is never a bare number. Each term has a stable anchor. */
export type GuideTerm = {
  id: string;
  title: Copy;
  body: Copy[];
  figure?: "context" | "elo" | "moe";
};
export type GuideSection = { id: string; title: Copy; intro: Copy; terms: GuideTerm[] };

export const guide: GuideSection[] = [
  {
    id: "basics",
    title: ["The basics", "Les bases"],
    intro: [
      "Five ideas explain most of what separates one text model from another.",
      "Cinq notions expliquent l’essentiel de ce qui sépare un modèle de texte d’un autre.",
    ],
    terms: [
      {
        id: "tokens",
        title: ["Tokens", "Jetons"],
        body: [
          [
            "Models read and write in tokens, pieces of words. In English a token is about three quarters of a word; French uses a few more per word. Prices for text are counted per million tokens.",
            "Les modèles lisent et écrivent en jetons, des morceaux de mots. En anglais, un jeton vaut environ trois quarts de mot ; le français en demande un peu plus. Le prix du texte se compte par million de jetons.",
          ],
          [
            "This catalog turns that into something you can picture: credits per page written, a page being about 500 words.",
            "Ce catalogue le traduit en quelque chose de concret : des crédits par page rédigée, une page faisant environ 500 mots.",
          ],
        ],
      },
      {
        id: "context",
        title: ["Context window", "Fenêtre de contexte"],
        figure: "context",
        body: [
          [
            "Everything a model can hold in mind at once: your question, the conversation so far, the notes or files Sub Rosa hands it, and its own answer. Past the limit, the oldest part falls out.",
            "Tout ce qu’un modèle peut garder en tête d’un coup : votre question, la conversation, les notes ou fichiers que Sub Rosa lui transmet, et sa propre réponse. Au-delà de la limite, le plus ancien disparaît.",
          ],
          [
            "128 thousand tokens is about 180 pages; one million is about 1,400. A bigger window helps with long documents, but it does not make a model smarter.",
            "128 000 jetons, c’est environ 180 pages ; un million, environ 1 400. Une grande fenêtre aide pour les longs documents, mais ne rend pas un modèle plus intelligent.",
          ],
        ],
      },
      {
        id: "reasoning",
        title: ["Reasoning", "Raisonnement"],
        body: [
          [
            "Some models think before they answer: they write a hidden draft, check it, then reply. It costs time and tokens, and pays off on math, planning, code and anything with several steps.",
            "Certains modèles réfléchissent avant de répondre : ils écrivent un brouillon caché, le vérifient, puis répondent. Cela coûte du temps et des jetons, et se révèle payant pour les maths, la planification, le code et tout ce qui comporte plusieurs étapes.",
          ],
          [
            "Many let you set the effort. For a quick rewrite, low effort is enough; for a hard problem, high effort is worth the wait.",
            "Beaucoup permettent de régler l’effort. Pour une reformulation rapide, un effort faible suffit ; pour un problème difficile, un effort élevé vaut l’attente.",
          ],
        ],
      },
      {
        id: "tools",
        title: ["Tool calling", "Appel d’outils"],
        body: [
          [
            "The ability to ask Sub Rosa to do something instead of only writing text: search your notes, read a file, search the web, create an image. Sub Rosa’s agent is built on it.",
            "La capacité de demander à Sub Rosa de faire quelque chose au lieu de seulement écrire : chercher dans vos notes, lire un fichier, chercher sur le web, créer une image. L’agent de Sub Rosa repose dessus.",
          ],
          [
            "A model without tool calling can chat, but the agent cannot work with it. Every family page says which versions have it.",
            "Un modèle sans appel d’outils peut discuter, mais l’agent ne peut pas travailler avec lui. Chaque fiche indique quelles versions en disposent.",
          ],
        ],
      },
      {
        id: "vision",
        title: ["Multimodal models", "Modèles multimodaux"],
        body: [
          [
            "A model that reads more than text: photos, screenshots, scanned pages, sometimes audio or video. Sub Rosa switches to one when you attach a picture.",
            "Un modèle qui lit plus que du texte : photos, captures d’écran, pages scannées, parfois l’audio ou la vidéo. Sub Rosa bascule sur l’un d’eux quand vous joignez une image.",
          ],
        ],
      },
    ],
  },
  {
    id: "under-the-hood",
    title: ["Under the hood", "Sous le capot"],
    intro: [
      "What the specification tables mean, and why two models of the same size can behave very differently.",
      "Ce que veulent dire les fiches techniques, et pourquoi deux modèles de même taille peuvent se comporter très différemment.",
    ],
    terms: [
      {
        id: "parameters",
        title: ["Parameters", "Paramètres"],
        body: [
          [
            "The numbers a model learned during training, counted in billions (B) or trillions (T). More parameters can hold more knowledge, but training quality matters as much as size.",
            "Les nombres qu’un modèle a appris pendant son entraînement, comptés en milliards (Md) ; un billion (en anglais « T ») vaut 1 000 Md. Davantage de paramètres peuvent contenir plus de connaissances, mais la qualité de l’entraînement compte autant que la taille.",
          ],
        ],
      },
      {
        id: "moe",
        title: [
          "Mixture of experts and active parameters",
          "Mélange d’experts et paramètres actifs",
        ],
        figure: "moe",
        body: [
          [
            "Many recent models are split into experts, and only a few experts work on each token. A model listed as 1T total and 32B active has the knowledge of a very large model and roughly the speed and cost of a 32B one.",
            "Beaucoup de modèles récents sont découpés en experts, et seuls quelques-uns travaillent sur chaque jeton. Un modèle annoncé à 1 000 Md de paramètres au total et 32 Md actifs a les connaissances d’un très grand modèle, et à peu près la vitesse et le coût d’un modèle de 32 Md.",
          ],
        ],
      },
      {
        id: "open-weights",
        title: ["Open weights", "Poids ouverts"],
        body: [
          [
            "The maker publishes the model itself, so anyone can run it on their own machines. That is why open models can be served in private mode by a provider that keeps nothing; closed models only run at their maker.",
            "Le fabricant publie le modèle lui-même : tout le monde peut le faire tourner sur ses propres machines. C’est pour cela que les modèles ouverts peuvent être servis en mode privé par un fournisseur qui ne garde rien ; les modèles fermés ne tournent que chez leur fabricant.",
          ],
          [
            "The license says what you may do with the weights. MIT and Apache 2.0 allow almost anything, including commercial use.",
            "La licence dit ce que vous pouvez faire des poids. MIT et Apache 2.0 autorisent presque tout, usage commercial compris.",
          ],
        ],
      },
      {
        id: "privacy",
        title: ["Private, anonymized, E2EE", "Privé, anonymisé, E2EE"],
        body: [
          [
            "Private: the provider that runs the model keeps nothing from your request once it has answered. Anonymized: your request reaches the model maker’s servers without anything that says who you are, and the maker’s own retention rules apply to its content.",
            "Privé : le fournisseur qui fait tourner le modèle ne garde rien de votre demande une fois la réponse donnée. Anonymisé : votre demande arrive sur les serveurs du fabricant sans rien qui dise qui vous êtes, et ses propres règles de conservation s’appliquent à son contenu.",
          ],
          [
            "E2EE versions are listed by their provider as encrypted end to end. That is the provider’s stated policy, not something Sub Rosa verifies, and these versions usually cannot call tools.",
            "Les versions E2EE sont annoncées chiffrées de bout en bout par leur fournisseur. C’est sa politique déclarée, pas une vérification de Sub Rosa, et ces versions ne peuvent en général pas appeler d’outils.",
          ],
        ],
      },
      {
        id: "credits",
        title: ["Credits and prices", "Crédits et prix"],
        body: [
          [
            "One credit is one US cent. Text is priced per token, images per picture, video per second, voice per character, transcription per minute of audio. The app shows the exact price before anything is charged.",
            "Un crédit vaut un centime de dollar. Le texte se paie au jeton, l’image à l’image, la vidéo à la seconde, la voix au caractère, la transcription à la minute d’audio. L’app affiche le prix exact avant toute dépense.",
          ],
        ],
      },
    ],
  },
  {
    id: "benchmarks",
    title: ["Reading a benchmark", "Lire un benchmark"],
    intro: [
      "Scores help you compare, as long as you know what they measure and who measured them.",
      "Les scores aident à comparer, à condition de savoir ce qu’ils mesurent et qui les a mesurés.",
    ],
    terms: [
      {
        id: "why-benchmarks",
        title: [
          "What a benchmark tells you, and what it does not",
          "Ce qu’un benchmark dit, et ce qu’il ne dit pas",
        ],
        body: [
          [
            "A benchmark runs every model through the same test. It is the fairest way to compare, but it measures one thing on one day: a model that leads on code can trail at writing, and your own task is the real test.",
            "Un benchmark fait passer le même test à chaque modèle. C’est la façon la plus juste de comparer, mais il mesure une chose, un jour donné : un modèle en tête en code peut être derrière en rédaction, et votre propre tâche reste le vrai test.",
          ],
          [
            "Every score in this catalog shows who measured it and when. Small gaps rarely matter in practice.",
            "Chaque score de ce catalogue indique qui l’a mesuré et quand. Les petits écarts comptent rarement en pratique.",
          ],
        ],
      },
      {
        id: "intelligence-index",
        title: ["Intelligence Index", "Intelligence Index"],
        body: [
          [
            "Artificial Analysis runs about ten tests of reasoning, knowledge, math, code and agent work on every text model, the same way, and averages them into one score out of 100.",
            "Artificial Analysis fait passer une dizaine de tests de raisonnement, de connaissances, de maths, de code et de travail en agent à chaque modèle de texte, de la même façon, et en calcule la moyenne sur 100.",
          ],
          [
            "Two or three points apart is a close call. Ten points apart is a different class of model.",
            "Deux ou trois points d’écart, c’est serré. Dix points d’écart, c’est une autre classe de modèle.",
          ],
        ],
      },
      {
        id: "elo",
        title: ["Arenas and Elo ratings", "Arènes et classement Elo"],
        figure: "elo",
        body: [
          [
            "For images, video and voices there is no right answer to check, so arenas ask people. Two results of the same request are shown side by side without the model names, and the voter picks one. Thousands of duels give each model an Elo rating, as in chess.",
            "Pour les images, la vidéo et les voix, il n’y a pas de bonne réponse à vérifier : les arènes demandent donc aux gens. Deux résultats de la même demande sont montrés côte à côte sans le nom des modèles, et la personne en choisit un. Des milliers de duels donnent à chaque modèle un classement Elo, comme aux échecs.",
          ],
          [
            "Only the gap means something: 100 points apart, the higher model wins about 64% of duels. That is why the catalog shows Elo as dots on an axis rather than bars from zero.",
            "Seul l’écart a un sens : à 100 points d’écart, le modèle le mieux classé gagne environ 64 % des duels. C’est pourquoi le catalogue montre l’Elo en points sur un axe plutôt qu’en barres partant de zéro.",
          ],
        ],
      },
      {
        id: "wer",
        title: ["Word error rate", "Taux d’erreur de mots"],
        body: [
          [
            "For transcription: the share of words the model misses, adds or gets wrong. Lower is better. At 5%, one word in twenty needs fixing; under 3%, a transcript reads almost clean. Accents, noise and crosstalk raise it for every model.",
            "Pour la transcription : la part de mots que le modèle oublie, ajoute ou écrit de travers. Plus c’est bas, mieux c’est. À 5 %, un mot sur vingt est à corriger ; sous 3 %, la transcription se lit presque sans retouche. Les accents, le bruit et les voix qui se chevauchent le font monter pour tous les modèles.",
          ],
        ],
      },
      {
        id: "vendor-scores",
        title: ["Independent or announced by the maker", "Indépendant ou annoncé par le fabricant"],
        body: [
          [
            "Independent scores come from a third party that tests every model the same way. Makers also publish their own numbers, with their own settings, at launch. The catalog keeps the two apart and labels the second kind.",
            "Les scores indépendants viennent d’un tiers qui teste chaque modèle de la même façon. Les fabricants publient aussi leurs propres chiffres, avec leurs propres réglages, au lancement. Le catalogue sépare les deux et signale les seconds.",
          ],
        ],
      },
    ],
  },
  {
    id: "media",
    title: ["Images, video and sound", "Images, vidéo et son"],
    intro: [
      "The words that come up when you make pictures, clips, voices and music.",
      "Les mots qui reviennent quand on fait des images, des plans, des voix et de la musique.",
    ],
    terms: [
      {
        id: "text-rendering",
        title: ["Text in images", "Texte dans l’image"],
        body: [
          [
            "Drawing readable letters is hard for image models: many still misspell signs and labels. Families that do it well say so, and it matters for posters, menus, packaging and slides.",
            "Dessiner des lettres lisibles est difficile pour les modèles d’image : beaucoup écorchent encore panneaux et étiquettes. Les familles qui le font bien l’indiquent, et cela compte pour les affiches, menus, emballages et diapositives.",
          ],
        ],
      },
      {
        id: "edit-vs-retouch",
        title: ["Editing and retouching", "Édition et retouche"],
        body: [
          [
            "An edit changes a picture from an instruction: the model may redraw much of it. A retouch changes only the zone you paint and keeps every other pixel. Sub Rosa offers both, in separate tabs.",
            "Une édition modifie une image à partir d’une consigne : le modèle peut en redessiner une grande partie. Une retouche ne change que la zone que vous peignez et garde tous les autres pixels. Sub Rosa propose les deux, dans des onglets séparés.",
          ],
        ],
      },
      {
        id: "video-modes",
        title: ["Text, image or references to video", "Texte, image ou références vers vidéo"],
        body: [
          [
            "Text to video starts from a description. Image to video animates a picture you supply, which keeps its look. References to video takes several images of a character or product and keeps them consistent across clips.",
            "Le texte vers vidéo part d’une description. L’image vers vidéo anime une image que vous fournissez, et conserve son aspect. Le mode références vers vidéo prend plusieurs images d’un personnage ou d’un produit et les garde cohérents d’un plan à l’autre.",
          ],
        ],
      },
      {
        id: "native-audio",
        title: ["Native sound and lip-sync", "Son natif et synchronisation labiale"],
        body: [
          [
            "Recent video models generate the soundtrack with the picture: voices, effects, ambience. Lip-sync means the mouths match the words, sometimes in several languages. Without native sound, a clip is silent and you add sound afterwards.",
            "Les modèles vidéo récents génèrent la bande-son avec l’image : voix, bruitages, ambiance. La synchronisation labiale fait correspondre les bouches aux mots, parfois en plusieurs langues. Sans son natif, le plan est muet et le son s’ajoute ensuite.",
          ],
        ],
      },
      {
        id: "multi-shot",
        title: ["Multi-shot and motion control", "Multi-plans et contrôle du mouvement"],
        body: [
          [
            "Multi-shot models cut between several shots inside one clip when the prompt describes them. Motion control copies the movement of a clip you supply onto your character.",
            "Les modèles multi-plans enchaînent plusieurs plans dans une même séquence quand le prompt les décrit. Le contrôle du mouvement reporte sur votre personnage le mouvement d’une vidéo que vous fournissez.",
          ],
        ],
      },
      {
        id: "voice-music",
        title: ["Voices, lyrics and licensing", "Voix, paroles et licences"],
        body: [
          [
            "Expressive voice models follow tags such as [whispers] or [laughs] written in the text. Music models differ on lyrics: some require them, some refuse them. Models trained on licensed catalogs are the safer choice for anything you publish.",
            "Les modèles de voix expressifs suivent des balises comme [whispers] ou [laughs] écrites dans le texte. Les modèles de musique diffèrent sur les paroles : certains les exigent, d’autres les refusent. Les modèles entraînés sur des catalogues sous licence sont le choix le plus sûr pour ce que vous publiez.",
          ],
        ],
      },
    ],
  },
];

/** Win share of the higher-rated side for a given Elo gap. */
export const eloWinShare = (gap: number) => 1 / (1 + 10 ** (-gap / 400));
