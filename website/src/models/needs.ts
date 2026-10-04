import type { Copy } from "../pages/docs-content";
import type { Category } from "./catalog";

/** A question a reader brings, answered with one family and, when it helps, a second. */
export type Need = {
  id: string;
  category: Category;
  question: Copy;
  pick: string;
  why: Copy;
  alternative?: { slug: string; why: Copy };
};

/** What each tool starts on in the app, so a reader can leave it alone. */
export type Default = { task: Copy; slug: string; model: string; why: Copy };

export const defaults: Default[] = [
  {
    task: ["Chat and agent", "Discussion et agent"],
    slug: "glm",
    model: "zai-org-glm-5-2",
    why: [
      "Reasons well, uses every tool, keeps no data.",
      "Raisonne bien, utilise tous les outils, ne garde rien.",
    ],
  },
  {
    task: ["Chat with an image", "Discussion avec une image"],
    slug: "kimi",
    model: "kimi-k2-6",
    why: [
      "Sub Rosa switches to it when you attach a picture.",
      "Sub Rosa bascule sur lui quand vous joignez une image.",
    ],
  },
  {
    task: ["Transcription", "Transcription"],
    slug: "parakeet",
    model: "nvidia/parakeet-tdt-0.6b-v3",
    why: [
      "Fast and accurate on meetings, keeps no data.",
      "Rapide et précis en réunion, ne garde rien.",
    ],
  },
  {
    task: ["Images from the agent", "Images de l’agent"],
    slug: "sd35",
    model: "venice-sd35",
    why: [
      "Private and very cheap for quick illustrations.",
      "Privé et très bon marché pour des illustrations rapides.",
    ],
  },
  {
    task: ["Studio edit, automatic", "Retouche Studio, automatique"],
    slug: "qwen-image-edit",
    model: "qwen-image-2-edit",
    why: [
      "Precise changes for about 2.5 credits.",
      "Des changements précis pour environ 2,5 crédits.",
    ],
  },
  {
    task: ["Retouch a painted zone", "Retouche d’une zone peinte"],
    slug: "ideogram-edit",
    model: "ideogram-v4-5-edit",
    why: [
      "Changes only what you paint, leaves the rest intact.",
      "Ne change que ce que vous peignez, laisse le reste intact.",
    ],
  },
  {
    task: ["Studio film workflows", "Workflows de film du Studio"],
    slug: "kling-2",
    model: "kling-2.5-turbo-pro-image-to-video",
    why: [
      "Cheap and dependable for every shot of a film.",
      "Bon marché et fiable pour chaque plan d’un film.",
    ],
  },
  {
    task: ["Narration", "Narration"],
    slug: "kokoro",
    model: "tts-kokoro",
    why: ["Private and by far the cheapest voice.", "Privée et de loin la voix la moins chère."],
  },
  {
    task: ["Music in workflows", "Musique des workflows"],
    slug: "ace-step",
    model: "ace-step-15",
    why: [
      "The cheapest music, with or without lyrics.",
      "La musique la moins chère, avec ou sans paroles.",
    ],
  },
];

export const needs: Need[] = [
  // Text
  {
    id: "everyday-writing",
    category: "text",
    question: [
      "Write, summarize and answer questions every day",
      "Écrire, résumer et répondre au quotidien",
    ],
    pick: "glm",
    why: [
      "The default: strong, private, works with every Sub Rosa tool.",
      "Le choix par défaut : solide, privé, compatible avec tous les outils de Sub Rosa.",
    ],
    alternative: {
      slug: "claude",
      why: [
        "A more polished writing voice, if anonymized is enough for you.",
        "Une plume plus soignée, si l’anonymisation vous suffit.",
      ],
    },
  },
  {
    id: "deep-reasoning",
    category: "text",
    question: [
      "Think through a hard problem or a long task",
      "Réfléchir à un problème difficile ou une longue tâche",
    ],
    pick: "kimi",
    why: [
      "Holds long chains of steps and tools, in private mode.",
      "Tient de longues chaînes d’étapes et d’outils, en mode privé.",
    ],
    alternative: {
      slug: "gpt",
      why: [
        "The Astra and Sol versions for the very hardest work, anonymized and dearer.",
        "Les versions Astra et Sol pour le plus difficile, anonymisées et plus chères.",
      ],
    },
  },
  {
    id: "code",
    category: "text",
    question: ["Write or fix code", "Écrire ou corriger du code"],
    pick: "claude",
    why: [
      "Careful code and long agent sessions, anonymized.",
      "Un code soigné et de longues sessions d’agent, anonymisé.",
    ],
    alternative: {
      slug: "kimi",
      why: [
        "Strong coding versions that keep no data.",
        "Des versions fortes en code qui ne gardent rien.",
      ],
    },
  },
  {
    id: "read-image",
    category: "text",
    question: [
      "Ask about a photo, a screenshot or a scanned page",
      "Interroger une photo, une capture ou une page scannée",
    ],
    pick: "kimi",
    why: [
      "Reads images and keeps no data; Sub Rosa picks it for you.",
      "Lit les images et ne garde rien ; Sub Rosa le choisit pour vous.",
    ],
    alternative: {
      slug: "gemini",
      why: [
        "Also takes audio and video, fast and cheap, anonymized.",
        "Accepte aussi l’audio et la vidéo, rapide et bon marché, anonymisé.",
      ],
    },
  },
  {
    id: "long-documents",
    category: "text",
    question: [
      "Work over a very long document or many notes at once",
      "Travailler sur un très long document ou beaucoup de notes",
    ],
    pick: "deepseek",
    why: [
      "A very large context at a low price, in private mode.",
      "Un très grand contexte à petit prix, en mode privé.",
    ],
    alternative: {
      slug: "gemini",
      why: [
        "A very large context that also reads images and audio.",
        "Un très grand contexte qui lit aussi les images et l’audio.",
      ],
    },
  },
  {
    id: "fast-cheap",
    category: "text",
    question: ["Get quick answers for very little", "Des réponses rapides pour presque rien"],
    pick: "mercury",
    why: [
      "Writes many words at once: replies arrive almost instantly.",
      "Écrit beaucoup de mots d’un coup : les réponses arrivent presque instantanément.",
    ],
    alternative: {
      slug: "qwen-open",
      why: [
        "Cheap, private, and the 27B version reads images.",
        "Bon marché, privé, et la version 27B lit les images.",
      ],
    },
  },
  {
    id: "maximum-privacy",
    category: "text",
    question: [
      "Keep a sensitive conversation as private as possible",
      "Garder une conversation sensible aussi privée que possible",
    ],
    pick: "glm",
    why: [
      "Every version is private, and some are listed as end-to-end encrypted.",
      "Toutes les versions sont privées, et certaines sont annoncées chiffrées de bout en bout.",
    ],
    alternative: {
      slug: "kimi",
      why: [
        "Private too, with a version listed as end-to-end encrypted.",
        "Privé lui aussi, avec une version annoncée chiffrée de bout en bout.",
      ],
    },
  },
  {
    id: "uncensored-creative",
    category: "text",
    question: [
      "Write fiction or role play without refusals",
      "Écrire de la fiction ou du jeu de rôle sans refus",
    ],
    pick: "venice-uncensored",
    why: [
      "Built to follow creative requests others decline, private.",
      "Conçu pour suivre les demandes créatives que d’autres refusent, privé.",
    ],
    alternative: {
      slug: "uncensored",
      why: [
        "Community models with their safety filters removed.",
        "Des modèles communautaires dont les filtres ont été retirés.",
      ],
    },
  },
  // Transcription
  {
    id: "meetings",
    category: "transcription",
    question: ["Transcribe meetings and dictations", "Transcrire des réunions et des dictées"],
    pick: "parakeet",
    why: [
      "The default: fast, accurate, private, among the cheapest.",
      "Le choix par défaut : rapide, précis, privé, parmi les moins chers.",
    ],
    alternative: {
      slug: "xai-stt",
      why: [
        "Cheaper still, anonymized rather than private.",
        "Encore moins cher, anonymisé plutôt que privé.",
      ],
    },
  },
  {
    id: "multilingual",
    category: "transcription",
    question: [
      "Transcribe several languages or strong accents",
      "Transcrire plusieurs langues ou de forts accents",
    ],
    pick: "whisper",
    why: [
      "Broad language coverage at the same low price, private.",
      "Une large couverture des langues au même petit prix, privé.",
    ],
    alternative: {
      slug: "scribe",
      why: [
        "Over 90 languages with automatic detection, anonymized and a little dearer.",
        "Plus de 90 langues détectées automatiquement, anonymisé et un peu plus cher.",
      ],
    },
  },
  // Images
  {
    id: "photoreal",
    category: "image",
    question: ["Make a photo that looks real", "Faire une photo qui semble réelle"],
    pick: "nano-banana",
    why: [
      "Follows long, detailed prompts and knows real places and objects.",
      "Suit des consignes longues et détaillées, et connaît lieux et objets réels.",
    ],
    alternative: {
      slug: "flux",
      why: [
        "Photographic detail in skin, materials and light, for about 1.5 credits.",
        "Du détail photographique dans la peau, les matières et la lumière, pour environ 1,5 crédit.",
      ],
    },
  },
  {
    id: "text-in-image",
    category: "image",
    question: [
      "Put readable words in the picture: a poster, a label, a menu",
      "Mettre des mots lisibles dans l’image : affiche, étiquette, menu",
    ],
    pick: "ideogram",
    why: ["Lettering is its specialty.", "Le lettrage est sa spécialité."],
    alternative: {
      slug: "qwen-image",
      why: [
        "Small text in many languages, for far less.",
        "Du petit texte en de nombreuses langues, pour bien moins cher.",
      ],
    },
  },
  {
    id: "graphic-design",
    category: "image",
    question: [
      "Design a logo, an icon or a brand visual",
      "Créer un logo, une icône ou un visuel de marque",
    ],
    pick: "recraft",
    why: [
      "Made for design work: intentional composition, cohesive color, structured text.",
      "Pensé pour le graphisme : composition voulue, couleurs cohérentes, texte structuré.",
    ],
    alternative: {
      slug: "gpt-image",
      why: [
        "Follows a detailed brief closely, text included.",
        "Suit de près un brief détaillé, texte compris.",
      ],
    },
  },
  {
    id: "illustration",
    category: "image",
    question: [
      "Draw an illustration, a painting or an anime style",
      "Dessiner une illustration, une peinture ou un style anime",
    ],
    pick: "krea",
    why: [
      "Expressive styles that avoid a generic look; Turbo is private.",
      "Des styles expressifs loin du rendu générique ; Turbo est privé.",
    ],
    alternative: {
      slug: "anime-wai",
      why: [
        "Specialized in anime and manga, private and cheap.",
        "Spécialisé anime et manga, privé et bon marché.",
      ],
    },
  },
  {
    id: "character-consistency",
    category: "image",
    question: [
      "Keep the same character across several images",
      "Garder le même personnage sur plusieurs images",
    ],
    pick: "nano-banana",
    why: [
      "Keeps faces and outfits steady from one image to the next.",
      "Garde visages et tenues stables d’une image à l’autre.",
    ],
    alternative: {
      slug: "seedream",
      why: ["Consistent series at a lower price.", "Des séries cohérentes à moindre prix."],
    },
  },
  {
    id: "fast-cheap-image",
    category: "image",
    question: [
      "Try many ideas quickly for almost nothing",
      "Essayer beaucoup d’idées vite et pour presque rien",
    ],
    pick: "z-image",
    why: [
      "Very fast, private, about half a credit an image.",
      "Très rapide, privé, environ un demi-crédit l’image.",
    ],
    alternative: {
      slug: "sd35",
      why: [
        "The agent’s default: private and very cheap.",
        "Le choix par défaut de l’agent : privé et très bon marché.",
      ],
    },
  },
  // Edit
  {
    id: "precise-edit",
    category: "edit",
    question: [
      "Change one thing and keep everything else",
      "Changer une chose et garder tout le reste",
    ],
    pick: "qwen-image-edit",
    why: [
      "Sub Rosa’s automatic choice: precise and cheap.",
      "Le choix automatique de Sub Rosa : précis et bon marché.",
    ],
    alternative: {
      slug: "ideogram-edit",
      why: [
        "Paint the zone yourself in the Retouch tab for exact control.",
        "Peignez la zone vous-même dans l’onglet Retouche pour un contrôle exact.",
      ],
    },
  },
  {
    id: "multi-image-compose",
    category: "edit",
    question: ["Combine several pictures into one", "Combiner plusieurs images en une seule"],
    pick: "nano-banana-edit",
    why: [
      "Blends up to 3 photos while keeping people recognizable.",
      "Mélange jusqu’à 3 photos en gardant les personnes reconnaissables.",
    ],
    alternative: {
      slug: "seedream-edit",
      why: [
        "One coherent scene from several images, for less.",
        "Une scène cohérente à partir de plusieurs images, pour moins cher.",
      ],
    },
  },
  {
    id: "retouch-text",
    category: "edit",
    question: ["Fix or replace the text on an image", "Corriger ou remplacer le texte d’une image"],
    pick: "ideogram-edit",
    why: [
      "Strong lettering, only inside the zone you paint.",
      "Un lettrage soigné, uniquement dans la zone que vous peignez.",
    ],
    alternative: {
      slug: "qwen-image-edit",
      why: [
        "Clean text edits for a fraction of the price.",
        "Des retouches de texte nettes pour une fraction du prix.",
      ],
    },
  },
  // Video
  {
    id: "cinematic",
    category: "video",
    question: ["Film a cinematic shot", "Tourner un plan cinématographique"],
    pick: "kling-v3",
    why: [
      "The all-rounder: real camera work, sound and several shots in one prompt.",
      "Le polyvalent : vrais mouvements de caméra, son et plusieurs plans dans un prompt.",
    ],
    alternative: {
      slug: "veo",
      why: [
        "Short, polished, realistic clips with dialogue and ambience.",
        "Des plans courts, soignés et réalistes, avec dialogues et ambiance.",
      ],
    },
  },
  {
    id: "animate-image",
    category: "video",
    question: ["Bring a still image to life", "Animer une image fixe"],
    pick: "kling-v3",
    why: ["Starts from your image and keeps its look.", "Part de votre image et garde son allure."],
    alternative: {
      slug: "grok-imagine-video",
      why: [
        "Every version is private, with sound, from 1 to 15 s.",
        "Toutes les versions sont privées, avec le son, de 1 à 15 s.",
      ],
    },
  },
  {
    id: "dialogue",
    category: "video",
    question: ["A scene where people speak", "Une scène où des personnages parlent"],
    pick: "veo",
    why: [
      "Dialogue, effects and ambience made in the same pass.",
      "Dialogues, bruitages et ambiance générés d’un seul coup.",
    ],
    alternative: {
      slug: "happyhorse",
      why: [
        "Lip-sync in seven languages, French included.",
        "Synchronisation labiale en sept langues, dont le français.",
      ],
    },
  },
  {
    id: "character-references",
    category: "video",
    question: [
      "Keep the same character or product across shots",
      "Garder le même personnage ou produit d’un plan à l’autre",
    ],
    pick: "kling-o3",
    why: [
      "Built from your reference images to keep a face identical.",
      "Construit à partir de vos images de référence pour garder un visage identique.",
    ],
    alternative: {
      slug: "seedance-2",
      why: [
        "References and audio in, a synced scene out; no recognizable faces in photos.",
        "Références et audio en entrée, une scène synchronisée en sortie ; pas de visages reconnaissables sur photo.",
      ],
    },
  },
  {
    id: "long-shot",
    category: "video",
    question: ["One long continuous shot", "Un long plan continu"],
    pick: "seedance-2-5",
    why: ["Up to 30 s in one pass, with sound.", "Jusqu’à 30 s d’un seul tenant, avec le son."],
    alternative: {
      slug: "wan-3",
      why: ["Also up to 30 s, at a mid-range price.", "Jusqu’à 30 s aussi, à prix moyen."],
    },
  },
  {
    id: "fast-cheap-video",
    category: "video",
    question: ["Draft many clips for little", "Faire beaucoup d’essais pour peu"],
    pick: "longcat",
    why: [
      "The lowest price per second, in private mode.",
      "Le prix par seconde le plus bas, en mode privé.",
    ],
    alternative: {
      slug: "kling-2",
      why: [
        "Cheap, dependable, and what Studio workflows use.",
        "Bon marché, fiable, et utilisé par les workflows du Studio.",
      ],
    },
  },
  {
    id: "private-video",
    category: "video",
    question: ["Keep a video project private", "Garder un projet vidéo privé"],
    pick: "grok-imagine-video",
    why: ["Every version runs in private mode.", "Toutes les versions tournent en mode privé."],
    alternative: {
      slug: "minimax-h3",
      why: [
        "H3 Max is private, with stereo sound, at a low price.",
        "H3 Max est privé, avec un son stéréo, à petit prix.",
      ],
    },
  },
  // Voice
  {
    id: "narration",
    category: "voice",
    question: ["Read a note or narrate a film", "Lire une note ou narrer un film"],
    pick: "kokoro",
    why: [
      "The default: private and by far the cheapest.",
      "Le choix par défaut : privé et de loin le moins cher.",
    ],
    alternative: {
      slug: "elevenlabs-tts",
      why: [
        "More natural narration in French and other languages, anonymized.",
        "Une narration plus naturelle en français et dans d’autres langues, anonymisée.",
      ],
    },
  },
  {
    id: "expressive-voice",
    category: "voice",
    question: [
      "A voice that acts: whispers, laughs, pauses",
      "Une voix qui joue : murmures, rires, pauses",
    ],
    pick: "gemini-flash-tts",
    why: [
      "Steer the delivery with tags written in the text.",
      "Dirigez l’interprétation avec des balises écrites dans le texte.",
    ],
    alternative: {
      slug: "xai-tts",
      why: [
        "Inline tags for pauses and laughter, at a low price.",
        "Des balises pour les pauses et les rires, à petit prix.",
      ],
    },
  },
  {
    id: "private-voice",
    category: "voice",
    question: [
      "Read in French without leaving private mode",
      "Lire en français sans quitter le mode privé",
    ],
    pick: "qwen3-tts",
    why: [
      "Ten languages, French included, in private mode.",
      "Dix langues, dont le français, en mode privé.",
    ],
    alternative: {
      slug: "chatterbox-hd",
      why: ["Expressive and private.", "Expressif et privé."],
    },
  },
  // Music
  {
    id: "song-with-lyrics",
    category: "music",
    question: ["A song with your own lyrics", "Une chanson sur vos propres paroles"],
    pick: "minimax-music",
    why: [
      "Sings your lyrics over a full arrangement.",
      "Chante vos paroles sur un arrangement complet.",
    ],
    alternative: {
      slug: "ace-step",
      why: [
        "Lyrics optional, the cheapest music here.",
        "Paroles facultatives, la musique la moins chère ici.",
      ],
    },
  },
  {
    id: "instrumental-score",
    category: "music",
    question: ["Background music of an exact length", "Une musique de fond d’une durée précise"],
    pick: "stable-audio",
    why: [
      "Fast instrumentals, ambient beds and cues, 5 to 180 s.",
      "Instrumentaux, nappes et ponctuations rapides, de 5 à 180 s.",
    ],
    alternative: {
      slug: "lyria",
      why: [
        "A structured piece with intro and verses, up to 3 minutes.",
        "Un morceau structuré, avec intro et couplets, jusqu’à 3 minutes.",
      ],
    },
  },
  {
    id: "published-music",
    category: "music",
    question: ["Music for something you will publish", "De la musique pour une œuvre publiée"],
    pick: "sonilo-music",
    why: [
      "Trained on licensed catalogs, cleared for commercial use.",
      "Entraîné sur des catalogues sous licence, utilisable commercialement.",
    ],
    alternative: {
      slug: "elevenlabs-music",
      why: [
        "Also trained on licensed catalogs, polished and dearer.",
        "Entraîné lui aussi sur des catalogues sous licence, soigné et plus cher.",
      ],
    },
  },
  // Effects
  {
    id: "sound-effects",
    category: "effects",
    question: [
      "A door, rain, footsteps for a scene",
      "Une porte, la pluie, des pas pour une scène",
    ],
    pick: "elevenlabs-sound-effects",
    why: [
      "Clean, film-ready foley and ambience.",
      "Des bruitages et ambiances nets, prêts pour un film.",
    ],
    alternative: {
      slug: "mmaudio",
      why: ["The cheapest effects, up to 30 s.", "Les bruitages les moins chers, jusqu’à 30 s."],
    },
  },
];
