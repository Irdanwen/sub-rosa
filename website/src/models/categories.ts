import type { Copy } from "../pages/docs-content";
import type { Category } from "./catalog";

/** What separates the models of one kind, and what to look at, with the guide terms behind it. */
export type CategoryGuide = {
  differs: Copy;
  criteria: { text: Copy; term?: string }[];
  priceAxis: Copy;
};

export const categoryGuides: Record<Category, CategoryGuide> = {
  text: {
    differs: [
      "Text models differ less by how well they write than by how far they can reason, how much they can read at once, whether they can use tools, and where your words go.",
      "Les modèles de texte se distinguent moins par leur façon d’écrire que par leur capacité à raisonner, la quantité qu’ils peuvent lire d’un coup, leur accès aux outils et l’endroit où vont vos mots.",
    ],
    criteria: [
      {
        text: [
          "Intelligence Index: overall reasoning, out of 100",
          "Intelligence Index : le raisonnement global, sur 100",
        ],
        term: "intelligence-index",
      },
      {
        text: [
          "Tool calling: required for Sub Rosa’s agent",
          "Appel d’outils : indispensable pour l’agent de Sub Rosa",
        ],
        term: "tools",
      },
      {
        text: [
          "Context window: how much it reads at once",
          "Fenêtre de contexte : ce qu’il lit d’un coup",
        ],
        term: "context",
      },
      {
        text: [
          "Private or anonymized: where your words go",
          "Privé ou anonymisé : où vont vos mots",
        ],
        term: "privacy",
      },
    ],
    priceAxis: [
      "Credits per page written (log scale)",
      "Crédits par page rédigée (échelle logarithmique)",
    ],
  },
  transcription: {
    differs: [
      "Transcription models differ by accuracy on real recordings, language coverage, speed and privacy. Prices stay low: an hour of audio costs from about 6 to 31 credits.",
      "Les modèles de transcription se distinguent par leur précision sur de vrais enregistrements, les langues couvertes, la vitesse et la confidentialité. Les prix restent bas : une heure d’audio coûte d’environ 6 à 31 crédits.",
    ],
    criteria: [
      {
        text: ["Word error rate: lower is better", "Taux d’erreur de mots : plus bas, mieux c’est"],
        term: "wer",
      },
      { text: ["Languages and accents covered", "Langues et accents couverts"] },
      { text: ["Private or anonymized", "Privé ou anonymisé"], term: "privacy" },
    ],
    priceAxis: [
      "Credits per hour of audio (log scale)",
      "Crédits par heure d’audio (échelle logarithmique)",
    ],
  },
  image: {
    differs: [
      "Image models differ in look (photographic, illustrated, designed), in how literally they follow a long prompt, in whether they can write readable text, and in price, from about half a credit to 15 credits an image.",
      "Les modèles d’image se distinguent par leur rendu (photographique, illustré, graphique), par leur fidélité à un long prompt, par leur capacité à écrire un texte lisible, et par le prix, d’environ un demi-crédit à 15 crédits l’image.",
    ],
    criteria: [
      {
        text: [
          "Arena rating: how often people prefer its images",
          "Classement d’arène : la fréquence à laquelle ses images sont préférées",
        ],
        term: "elo",
      },
      {
        text: [
          "Text in images: posters, labels, menus",
          "Texte dans l’image : affiches, étiquettes, menus",
        ],
        term: "text-rendering",
      },
      {
        text: ["Price per image and privacy", "Prix par image et confidentialité"],
        term: "credits",
      },
    ],
    priceAxis: ["Credits per image (log scale)", "Crédits par image (échelle logarithmique)"],
  },
  edit: {
    differs: [
      "Editing models differ in how much of the picture they keep intact, how well they follow a loose instruction, whether they can blend several photos, and whether they can fix text.",
      "Les modèles de retouche se distinguent par ce qu’ils gardent intact de l’image, leur compréhension d’une consigne vague, leur capacité à mélanger plusieurs photos et à corriger du texte.",
    ],
    criteria: [
      { text: ["Editing arena rating", "Classement de l’arène de retouche"], term: "elo" },
      {
        text: [
          "Edit or retouch: whole picture or painted zone",
          "Édition ou retouche : toute l’image ou une zone peinte",
        ],
        term: "edit-vs-retouch",
      },
      {
        text: ["Price per edit and privacy", "Prix par retouche et confidentialité"],
        term: "credits",
      },
    ],
    priceAxis: ["Credits per edit (log scale)", "Crédits par retouche (échelle logarithmique)"],
  },
  video: {
    differs: [
      "Video models differ in realism and motion, in clip length, in whether they make their own sound, in how well they keep a character from shot to shot, and in price, from about 2 to 62 credits per second.",
      "Les modèles vidéo se distinguent par le réalisme et le mouvement, la durée des plans, la présence d’un son natif, leur capacité à garder un personnage d’un plan à l’autre, et le prix, d’environ 2 à 62 crédits la seconde.",
    ],
    criteria: [
      {
        text: ["Arena rating, silent and with sound", "Classement d’arène, muet et avec le son"],
        term: "elo",
      },
      {
        text: [
          "Text, image or references as a starting point",
          "Texte, image ou références comme point de départ",
        ],
        term: "video-modes",
      },
      {
        text: ["Native sound and lip-sync", "Son natif et synchronisation labiale"],
        term: "native-audio",
      },
      {
        text: ["Clip length and price per second", "Durée des plans et prix à la seconde"],
        term: "credits",
      },
    ],
    priceAxis: [
      "Credits per second of video (log scale)",
      "Crédits par seconde de vidéo (échelle logarithmique)",
    ],
  },
  voice: {
    differs: [
      "Voice models differ in how natural they sound, how much they act (whispers, laughter, pauses), how many languages they speak well, and price, from about half a credit to 29 credits per page read.",
      "Les modèles de voix se distinguent par leur naturel, leur jeu (murmures, rires, pauses), le nombre de langues qu’ils parlent bien, et le prix, d’environ un demi-crédit à 29 crédits la page lue.",
    ],
    criteria: [
      {
        text: [
          "Speech arena rating: how natural it sounds",
          "Classement de l’arène vocale : le naturel de la voix",
        ],
        term: "elo",
      },
      {
        text: ["Expressive tags and languages", "Balises expressives et langues"],
        term: "voice-music",
      },
      {
        text: ["Price per page read and privacy", "Prix par page lue et confidentialité"],
        term: "credits",
      },
    ],
    priceAxis: [
      "Credits per page read aloud (log scale)",
      "Crédits par page lue (échelle logarithmique)",
    ],
  },
  music: {
    differs: [
      "Music models differ on lyrics (required, optional or refused), track length, structure, and on how they were trained, which matters if you publish the result.",
      "Les modèles de musique se distinguent par les paroles (exigées, facultatives ou refusées), la durée des morceaux, leur structure, et leur entraînement, qui compte si vous publiez le résultat.",
    ],
    criteria: [
      {
        text: [
          "Lyrics: required, optional or refused",
          "Paroles : exigées, facultatives ou refusées",
        ],
        term: "voice-music",
      },
      {
        text: [
          "Licensed training for published work",
          "Entraînement sous licence pour une œuvre publiée",
        ],
        term: "voice-music",
      },
    ],
    priceAxis: ["Credits per track (log scale)", "Crédits par morceau (échelle logarithmique)"],
  },
  effects: {
    differs: [
      "Sound effect models differ in realism, maximum length and licensing. None is ranked by a public arena yet, so the comparison rests on specs and price.",
      "Les modèles de bruitage se distinguent par leur réalisme, leur durée maximale et leur licence. Aucune arène publique ne les classe encore : la comparaison repose sur les caractéristiques techniques et le prix.",
    ],
    criteria: [
      { text: ["Maximum length", "Durée maximale"] },
      {
        text: [
          "Licensed training for published work",
          "Entraînement sous licence pour une œuvre publiée",
        ],
        term: "voice-music",
      },
    ],
    priceAxis: [
      "Credits per 10 seconds of sound (log scale)",
      "Crédits pour 10 secondes de son (échelle logarithmique)",
    ],
  },
};
