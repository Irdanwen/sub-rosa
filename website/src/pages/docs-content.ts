import { t } from "../lib/i18n";

export type Copy = readonly [en: string, fr: string];
export const read = ([en, fr]: Copy) => t(en, fr);

type Section = {
  id: string;
  title: Copy;
  text: Copy;
  steps?: Copy[];
};

export type Guide = {
  slug: string;
  category: "start" | "notes" | "intelligence" | "studio" | "account" | "reference";
  title: Copy;
  summary: Copy;
  sections: Section[];
  image?: { file: string; alt: Copy; caption: Copy };
  related?: string[];
};

export const categories: { id: Guide["category"]; title: Copy; description: Copy }[] = [
  {
    id: "start",
    title: ["Get started", "Premiers pas"],
    description: [
      "Install, connect your key and begin locally.",
      "Installez l’app, ajoutez votre clé et commencez en local.",
    ],
  },
  {
    id: "notes",
    title: ["Capture and notes", "Capturer et écrire"],
    description: [
      "Record, import, write and find your work.",
      "Enregistrez, importez, écrivez et retrouvez votre travail.",
    ],
  },
  {
    id: "intelligence",
    title: ["Agent and memory", "Agent et mémoire"],
    description: [
      "Ask questions and decide what Sub Rosa remembers.",
      "Posez des questions et choisissez ce que Sub Rosa retient.",
    ],
  },
  {
    id: "studio",
    title: ["Studio", "Studio"],
    description: [
      "Create media, projects and reusable flows.",
      "Créez des médias, des projets et des flux réutilisables.",
    ],
  },
  {
    id: "account",
    title: ["Account and sync", "Compte et synchronisation"],
    description: [
      "Connect devices while keeping control of your vault.",
      "Connectez vos appareils tout en gardant le contrôle de votre coffre.",
    ],
  },
  {
    id: "reference",
    title: ["Privacy and help", "Confidentialité et aide"],
    description: [
      "Understand data, credits and common problems.",
      "Comprenez les données, les crédits et les problèmes courants.",
    ],
  },
];

export const guides: Guide[] = [
  {
    slug: "install",
    category: "start",
    title: ["Install Sub Rosa", "Installer Sub Rosa"],
    summary: [
      "Choose the right download and start with local storage.",
      "Choisissez la bonne version et commencez avec un stockage local.",
    ],
    sections: [
      {
        id: "choose",
        title: ["Choose your device", "Choisir votre appareil"],
        text: [
          "The downloads page provides separate installers for Apple Silicon Macs, Intel Macs and 64-bit Windows PCs. Android is offered when a test APK has been published. iPhone access is currently through TestFlight and is not open on the public downloads page.",
          "La page de téléchargement propose des installateurs distincts pour les Mac Apple Silicon, les Mac Intel et les PC Windows 64 bits. Android apparaît lorsqu’un APK de test est publié. L’accès iPhone passe actuellement par TestFlight et n’est pas ouvert sur la page publique.",
        ],
        steps: [
          [
            "Open Downloads and select your device.",
            "Ouvrez Téléchargements et choisissez votre appareil.",
          ],
          [
            "Install and open Sub Rosa. On macOS, the download is signed and notarized. Windows may show a warning because its installer is not code-signed.",
            "Installez et ouvrez Sub Rosa. Sur macOS, le téléchargement est signé et notarisé. Windows peut afficher un avertissement car son installateur n’est pas signé.",
          ],
        ],
      },
      {
        id: "local",
        title: ["Start locally", "Commencer en local"],
        text: [
          "An account is optional. Your notes and recordings stay on this device until you choose to connect an account and enable encrypted sync. AI features need a Carpe Diem key.",
          "Un compte est facultatif. Vos notes et enregistrements restent sur cet appareil jusqu’à ce que vous choisissiez de connecter un compte et d’activer la synchronisation chiffrée. Les fonctions d’IA nécessitent une clé Carpe Diem.",
        ],
      },
    ],
    related: ["carpe-diem-key", "first-note"],
  },
  {
    slug: "carpe-diem-key",
    category: "start",
    title: ["Connect Carpe Diem", "Connecter Carpe Diem"],
    summary: [
      "Add the key used for transcription, chat and generation.",
      "Ajoutez la clé utilisée pour la transcription, le chat et la génération.",
    ],
    sections: [
      {
        id: "add",
        title: ["Add your key", "Ajouter votre clé"],
        text: [
          "Carpe Diem is a separate service. Sub Rosa uses the base URL and cdm_ key you provide; it does not create or fund that account for you.",
          "Carpe Diem est un service distinct. Sub Rosa utilise l’adresse de base et la clé cdm_ que vous fournissez ; il ne crée ni n’approvisionne ce compte à votre place.",
        ],
        steps: [
          ["Open Settings, then Carpe Diem.", "Ouvrez Réglages, puis Carpe Diem."],
          [
            "Enter the service base URL and your cdm_ key, then save. The app stores the key in the device keychain.",
            "Saisissez l’adresse de base du service et votre clé cdm_, puis enregistrez. L’app stocke la clé dans le trousseau de l’appareil.",
          ],
          [
            "Check the connection status before starting a paid task.",
            "Vérifiez l’état de connexion avant de lancer une tâche payante.",
          ],
        ],
      },
      {
        id: "credits",
        title: ["Credits and models", "Crédits et modèles"],
        text: [
          "Model requests consume your Carpe Diem credits. Review the quoted amount before media generation, and check your provider balance when a request cannot start. A Sub Rosa account does not replace the provider key.",
          "Les requêtes aux modèles consomment vos crédits Carpe Diem. Examinez le montant annoncé avant une génération de média et vérifiez votre solde fournisseur si une requête ne peut pas démarrer. Un compte Sub Rosa ne remplace pas la clé fournisseur.",
        ],
      },
    ],
    related: ["first-note", "usage-privacy"],
  },
  {
    slug: "first-note",
    category: "start",
    title: ["Create your first note", "Créer votre première note"],
    summary: [
      "Write directly or turn a conversation into a note.",
      "Écrivez directement ou transformez une conversation en note.",
    ],
    sections: [
      {
        id: "write",
        title: ["Write a note", "Écrire une note"],
        text: [
          "Create a note from the notes view and write in its body. The editor keeps headings, lists, links and other supported formatting in the note document.",
          "Créez une note depuis la vue Notes et écrivez dans son contenu. L’éditeur conserve les titres, les listes, les liens et les autres mises en forme prises en charge dans le document de la note.",
        ],
        steps: [
          [
            "Create a note and give it a clear title.",
            "Créez une note et donnez-lui un titre clair.",
          ],
          [
            "Write or paste text, then return to the list. Your work is saved locally.",
            "Écrivez ou collez du texte, puis revenez à la liste. Votre travail est enregistré en local.",
          ],
        ],
      },
      {
        id: "conversation",
        title: ["Capture a conversation", "Capturer une conversation"],
        text: [
          "You can also record a conversation. After recording, Sub Rosa transcribes the audio and prepares a structured note. Keep the app available while processing finishes; status remains visible on the note.",
          "Vous pouvez aussi enregistrer une conversation. Après l’enregistrement, Sub Rosa transcrit l’audio et prépare une note structurée. Laissez l’app disponible pendant le traitement ; son état reste visible sur la note.",
        ],
      },
    ],
    related: ["record", "edit-notes"],
  },
  {
    slug: "record",
    category: "notes",
    title: ["Record a conversation", "Enregistrer une conversation"],
    summary: [
      "Capture speech and review the resulting transcript and note.",
      "Capturez la parole et relisez la transcription et la note obtenues.",
    ],
    sections: [
      {
        id: "before",
        title: ["Before you record", "Avant d’enregistrer"],
        text: [
          "Allow microphone access when your device requests it. Desktop system audio and phone recording have different controls and permissions. Record only when everyone involved knows and agrees.",
          "Autorisez l’accès au microphone lorsque votre appareil le demande. Le son système sur ordinateur et l’enregistrement sur téléphone ont des commandes et autorisations différentes. N’enregistrez que si toutes les personnes concernées le savent et y consentent.",
        ],
      },
      {
        id: "capture",
        title: ["Record and finish", "Enregistrer et terminer"],
        text: [
          "Start recording from the app, speak normally and stop when the conversation ends. The note first shows processing progress, then its transcript and generated summary. You can leave the recording view after the audio has been saved.",
          "Démarrez l’enregistrement depuis l’app, parlez normalement et arrêtez à la fin de l’échange. La note affiche d’abord la progression du traitement, puis sa transcription et son résumé généré. Vous pouvez quitter la vue d’enregistrement une fois l’audio enregistré.",
        ],
        steps: [
          [
            "Check the selected audio source and start recording.",
            "Vérifiez la source audio sélectionnée et lancez l’enregistrement.",
          ],
          [
            "Stop the recording and open the new note to follow its progress.",
            "Arrêtez l’enregistrement et ouvrez la nouvelle note pour suivre sa progression.",
          ],
          [
            "Review the transcript before relying on the summary.",
            "Relisez la transcription avant de vous fier au résumé.",
          ],
        ],
      },
    ],
    related: ["first-note", "edit-notes", "troubleshooting"],
  },
  {
    slug: "dictation",
    category: "notes",
    title: ["Dictate text", "Dicter du texte"],
    summary: [
      "Turn a short spoken thought into editable writing.",
      "Transformez une courte idée dictée en texte modifiable.",
    ],
    sections: [
      {
        id: "use",
        title: ["Use dictation", "Utiliser la dictée"],
        text: [
          "Dictation is for a short passage you want to write, rather than a full meeting note. Start it from the app, speak, then stop and review the text before using it.",
          "La dictée sert à écrire un court passage plutôt qu’une note de réunion complète. Lancez-la depuis l’app, parlez, puis arrêtez et relisez le texte avant de l’utiliser.",
        ],
      },
      {
        id: "review",
        title: ["Review the result", "Relire le résultat"],
        text: [
          "The app may clean the transcription after speech recognition. Names and technical terms can still be wrong. Edit the result as you would any other text; a failed request does not replace text you already wrote.",
          "L’app peut nettoyer la transcription après la reconnaissance vocale. Les noms et termes techniques peuvent tout de même être erronés. Modifiez le résultat comme tout autre texte ; une requête échouée ne remplace pas ce que vous avez déjà écrit.",
        ],
      },
    ],
    related: ["record", "carpe-diem-key"],
  },
  {
    slug: "import",
    category: "notes",
    title: ["Import audio, video or a link", "Importer un audio, une vidéo ou un lien"],
    summary: [
      "Make existing material searchable as an ordinary note.",
      "Rendez un contenu existant consultable comme une note ordinaire.",
    ],
    sections: [
      {
        id: "start",
        title: ["Choose an import", "Choisir un import"],
        text: [
          "Drop a supported media file into the app or use the import-link control. The app fetches a link when permitted; it does not scrape arbitrary pages. Published captions are used when available, avoiding paid transcription.",
          "Déposez un fichier média pris en charge dans l’app ou utilisez la commande d’import de lien. L’app récupère un lien lorsque c’est permis ; elle n’extrait pas le contenu de pages arbitraires. Les sous-titres publiés sont utilisés lorsqu’ils existent, ce qui évite une transcription payante.",
        ],
      },
      {
        id: "read",
        title: ["Read the imported note", "Lire la note importée"],
        text: [
          "Once a transcript exists, the import becomes a normal note: you can read it, search it and ask the agent about it. Long transcripts can receive a chaptered long-form summary. Some audio codecs, including Opus and HE-AAC, are unsupported by the local decoder; the app may use its existing whole-file route when possible.",
          "Dès qu’une transcription existe, l’import devient une note ordinaire : vous pouvez la lire, la rechercher et interroger l’agent à son sujet. Les longues transcriptions peuvent recevoir un résumé détaillé avec chapitres. Certains codecs audio, dont Opus et HE-AAC, ne sont pas pris en charge par le décodeur local ; l’app peut utiliser sa voie existante pour le fichier entier lorsque c’est possible.",
        ],
      },
    ],
    related: ["find-notes", "troubleshooting"],
  },
  {
    slug: "edit-notes",
    category: "notes",
    title: ["Edit and rewrite a note", "Modifier et réécrire une note"],
    summary: [
      "Shape a note yourself and review AI rewrite suggestions.",
      "Façonnez votre note et examinez les propositions de réécriture de l’IA.",
    ],
    sections: [
      {
        id: "edit",
        title: ["Write in the note body", "Écrire dans la note"],
        text: [
          "The note body is a writing surface. Use the available formatting controls and keep a clear structure with headings and lists. Your edits remain part of the note, including after the generated summary is complete.",
          "Le contenu de la note est un espace d’écriture. Utilisez les commandes de mise en forme disponibles et gardez une structure claire avec des titres et des listes. Vos modifications restent dans la note, même après la fin du résumé généré.",
        ],
      },
      {
        id: "rewrite",
        title: ["Review a rewrite", "Examiner une réécriture"],
        text: [
          "Select a passage and request a rewrite. Sub Rosa proposes replacement text without changing your document. Compare it with the original, then accept or discard the proposal. Rewrites are transient: if you change the passage meanwhile, request a new proposal.",
          "Sélectionnez un passage et demandez une réécriture. Sub Rosa propose un remplacement sans modifier votre document. Comparez-le à l’original, puis acceptez ou écartez la proposition. Les réécritures sont temporaires : si vous modifiez le passage entre-temps, demandez une nouvelle proposition.",
        ],
      },
    ],
    related: ["first-note", "find-notes"],
  },
  {
    slug: "find-notes",
    category: "notes",
    title: ["Find and organize your notes", "Retrouver et organiser vos notes"],
    summary: [
      "Return to a conversation, transcript or imported note.",
      "Revenez à une conversation, une transcription ou une note importée.",
    ],
    sections: [
      {
        id: "search",
        title: ["Search your work", "Rechercher dans votre travail"],
        text: [
          "Use search in the app to find notes by their saved content. Imported transcripts become searchable once processing is complete. Open a result to inspect its note and transcription rather than trusting a snippet alone.",
          "Utilisez la recherche dans l’app pour retrouver des notes par leur contenu enregistré. Les transcriptions importées deviennent recherchables une fois le traitement terminé. Ouvrez un résultat pour consulter sa note et sa transcription plutôt que de vous fier au seul extrait.",
        ],
      },
      {
        id: "organize",
        title: ["Keep useful context", "Conserver le contexte utile"],
        text: [
          "Give notes meaningful titles and use the organization controls available on your device. If a note is still processing, wait for its final content before using it as a reference in another task.",
          "Donnez des titres explicites aux notes et utilisez les commandes de classement disponibles sur votre appareil. Si une note est encore en cours de traitement, attendez son contenu final avant de l’utiliser comme référence dans une autre tâche.",
        ],
      },
    ],
    related: ["import", "agent"],
  },
  {
    slug: "agent",
    category: "intelligence",
    title: ["Ask the agent about your work", "Interroger l’agent sur votre travail"],
    summary: [
      "Continue a conversation with the context of your notes.",
      "Poursuivez une conversation avec le contexte de vos notes.",
    ],
    sections: [
      {
        id: "ask",
        title: ["Ask a useful question", "Poser une question utile"],
        text: [
          "Open a chat and ask about a note, decision or topic. Mention the context you want the agent to use. It can search your local notes, but its answer should still be checked against the source note when accuracy matters.",
          "Ouvrez une conversation et posez une question sur une note, une décision ou un sujet. Précisez le contexte que l’agent doit utiliser. Il peut chercher dans vos notes locales, mais vérifiez sa réponse dans la note source lorsque la précision compte.",
        ],
      },
      {
        id: "continue",
        title: ["Continue and review", "Poursuivre et vérifier"],
        text: [
          "A new message starts a new turn. Work received from another device is history, not a paid job that runs again automatically. Review proposed actions before they change your work.",
          "Un nouveau message ouvre un nouveau tour. Le travail reçu d’un autre appareil est un historique, pas une tâche payante relancée automatiquement. Examinez les actions proposées avant qu’elles modifient votre travail.",
        ],
      },
    ],
    related: ["memory", "find-notes"],
  },
  {
    slug: "memory",
    category: "intelligence",
    title: ["Manage memory", "Gérer la mémoire"],
    summary: [
      "Choose whether useful facts carry across conversations.",
      "Choisissez si des faits utiles passent d’une conversation à l’autre.",
    ],
    sections: [
      {
        id: "how",
        title: ["How memory helps", "Comment la mémoire aide"],
        text: [
          "When enabled, Sub Rosa can extract durable facts from conversations and recall relevant ones in later chats. Extraction is best effort; a missed fact does not stop a chat turn.",
          "Lorsqu’elle est activée, Sub Rosa peut extraire des faits durables des conversations et rappeler ceux qui sont pertinents dans les échanges suivants. L’extraction est faite au mieux ; un fait manqué n’interrompt pas la conversation.",
        ],
      },
      {
        id: "control",
        title: ["Review and forget", "Examiner et oublier"],
        text: [
          "Open Settings, then Memory to review the saved facts. Disable memory to stop using it without deleting existing facts. Use an explicit forget action to remove a fact you no longer want kept.",
          "Ouvrez Réglages, puis Mémoire pour examiner les faits enregistrés. Désactivez la mémoire pour cesser de l’utiliser sans supprimer les faits existants. Utilisez une action d’oubli explicite pour retirer un fait que vous ne souhaitez plus conserver.",
        ],
      },
    ],
    related: ["agent", "usage-privacy"],
  },
  {
    slug: "assistants",
    category: "intelligence",
    title: ["Create your own assistants", "Créer ses propres assistants"],
    summary: [
      "Give a recurring task a reusable brief and review its permissions.",
      "Donnez à une tâche régulière une consigne réutilisable et vérifiez ses autorisations.",
    ],
    sections: [
      {
        id: "create",
        title: ["Define the assistant", "Définir l’assistant"],
        text: [
          "Open My assistants from chat. Describe what you need, review the proposed definition and save it with a clear name. You can edit the definition later instead of starting from scratch each time.",
          "Ouvrez Mes assistants depuis le chat. Décrivez votre besoin, examinez la définition proposée et enregistrez-la avec un nom clair. Vous pouvez la modifier ensuite au lieu de repartir de zéro à chaque fois.",
        ],
      },
      {
        id: "permissions",
        title: ["Review what it may do", "Vérifier ce qu’il peut faire"],
        text: [
          "An assistant definition can travel between your devices, but permissions for a conversation remain native to that device. Review access and proposed actions before letting an assistant use local notes, tools or media generation.",
          "Une définition d’assistant peut passer entre vos appareils, mais les autorisations d’une conversation restent propres à cet appareil. Vérifiez les accès et les actions proposées avant de laisser un assistant utiliser des notes locales, des outils ou la génération de médias.",
        ],
      },
    ],
    related: ["agent", "usage-privacy"],
  },
  {
    slug: "studio-media",
    category: "studio",
    title: ["Create media in Studio", "Créer des médias dans Studio"],
    summary: [
      "Generate images, video, speech, music and sounds.",
      "Générez des images, des vidéos, de la parole, de la musique et des sons.",
    ],
    image: {
      file: "studio-fr.png",
      alt: [
        "Studio start screen with media choices in French",
        "Écran d’accueil de Studio avec les choix de médias",
      ],
      caption: ["Studio on desktop, shown in French.", "Studio sur ordinateur."],
    },
    sections: [
      {
        id: "choose",
        title: ["Choose the result", "Choisir le résultat"],
        text: [
          "Start in Studio and choose image, video, speech, music or sound effects. Each path offers its own controls and available models. Model availability and credit prices can change; review the options shown in the app.",
          "Dans Studio, choisissez image, vidéo, parole, musique ou effets sonores. Chaque parcours propose ses propres réglages et modèles disponibles. Les modèles et les prix en crédits peuvent changer ; examinez les choix affichés dans l’app.",
        ],
      },
      {
        id: "generate",
        title: ["Generate and keep the result", "Générer et conserver le résultat"],
        text: [
          "Describe what you want, review the settings and quoted cost, then start the generation. Long jobs have a durable status and can resume after the app returns. Find completed results in the Studio gallery.",
          "Décrivez ce que vous voulez, examinez les réglages et le coût annoncé, puis lancez la génération. Les tâches longues ont un état durable et peuvent reprendre au retour de l’app. Retrouvez les résultats terminés dans la galerie Studio.",
        ],
      },
    ],
    related: ["film-project", "flows", "carpe-diem-key"],
  },
  {
    slug: "film-project",
    category: "studio",
    title: ["Plan and assemble a film", "Planifier et assembler un film"],
    summary: [
      "Keep a story, shots, takes and a montage together.",
      "Gardez ensemble une histoire, ses plans, ses prises et son montage.",
    ],
    image: {
      file: "film-fr.png",
      alt: ["Film project shot planning in French", "Planification des plans d’un projet de film"],
      caption: [
        "A film project keeps its shot plan beside the generated takes.",
        "Un projet de film garde son découpage près des prises générées.",
      ],
    },
    sections: [
      {
        id: "plan",
        title: ["Build the project", "Construire le projet"],
        text: [
          "Create a film project in Studio. Use its scenario, shot list and bible to keep characters, places and visual direction consistent. Review each shot prompt and reference before generating a take, because video generation uses credits.",
          "Créez un projet de film dans Studio. Utilisez son scénario, sa liste de plans et sa bible pour garder cohérents les personnages, les lieux et la direction visuelle. Relisez chaque prompt et référence avant de générer une prise, car la vidéo consomme des crédits.",
        ],
      },
      {
        id: "assemble",
        title: ["Assemble the montage", "Assembler le montage"],
        text: [
          "Select takes, arrange clips and adjust their timing in the montage. The montage is editable separately from the takes, so changing a clip does not overwrite the source media. Check export compatibility and keep the app open while a local export runs.",
          "Choisissez les prises, disposez les clips et réglez leur durée dans le montage. Le montage est modifiable séparément des prises : changer un clip n’écrase pas le média source. Vérifiez la compatibilité de l’export et gardez l’app ouverte pendant un export local.",
        ],
      },
    ],
    related: ["studio-media", "flows"],
  },
  {
    slug: "flows",
    category: "studio",
    title: ["Use reusable flows", "Utiliser les flux réutilisables"],
    summary: [
      "Connect creative steps into a repeatable process.",
      "Reliez des étapes créatives dans un processus réutilisable.",
    ],
    sections: [
      {
        id: "build",
        title: ["Build a flow", "Construire un flux"],
        text: [
          "On desktop, Studio offers a workflow canvas. On phone, the same work appears as guided Flows. Choose the steps, connect their inputs and review what each stage will produce before starting.",
          "Sur ordinateur, Studio propose un canevas de workflow. Sur téléphone, le même travail apparaît sous forme de Flux guidés. Choisissez les étapes, reliez leurs entrées et vérifiez ce que chaque étape produira avant de démarrer.",
        ],
      },
      {
        id: "run",
        title: ["Run and inspect", "Exécuter et examiner"],
        text: [
          "Some stages call paid models. Check the displayed settings and credit quote, run the flow and inspect each result before reusing it. A failed stage should be corrected before continuing with dependent stages.",
          "Certaines étapes appellent des modèles payants. Vérifiez les réglages et le coût en crédits affichés, lancez le flux et examinez chaque résultat avant de le réutiliser. Corrigez une étape échouée avant de poursuivre avec celles qui en dépendent.",
        ],
      },
    ],
    related: ["studio-media", "film-project"],
  },
  {
    slug: "account",
    category: "account",
    title: ["Sign in to your account", "Se connecter à son compte"],
    summary: [
      "Use the separate account website without giving up local work.",
      "Utilisez le site de compte distinct sans abandonner le travail local.",
    ],
    sections: [
      {
        id: "open",
        title: ["Open your account", "Ouvrir votre compte"],
        text: [
          "Select Your account in the website header or open the account screen in the app. The dedicated account website handles sign-in, devices and security. Your Carpe Diem account and credits remain separate.",
          "Choisissez Votre compte dans l’en-tête du site ou ouvrez l’écran Compte dans l’app. Le site de compte dédié gère la connexion, les appareils et la sécurité. Votre compte Carpe Diem et ses crédits restent distincts.",
        ],
        steps: [
          [
            "Choose Sign in or Create an account on the dedicated account website.",
            "Choisissez Se connecter ou Créer un compte sur le site de compte dédié.",
          ],
          [
            "Complete the configured identity provider’s verification. A passkey can be used after one has been added to this Sub Rosa account.",
            "Terminez la vérification du fournisseur d’identité configuré. Une clé d’accès peut être utilisée après avoir été ajoutée à ce compte Sub Rosa.",
          ],
        ],
      },
      {
        id: "vault",
        title: ["Understand the vault", "Comprendre le coffre"],
        text: [
          "Signing in proves account access; it does not by itself unlock encrypted notes. Unlock the vault with an authorized device or your recovery kit when prompted. Never enter the recovery key into a public support request.",
          "La connexion prouve l’accès au compte ; elle ne déverrouille pas à elle seule les notes chiffrées. Déverrouillez le coffre avec un appareil autorisé ou votre kit de récupération lorsque cela vous est demandé. Ne saisissez jamais la clé de récupération dans un rapport d’assistance public.",
        ],
      },
    ],
    related: ["connect-device", "recovery", "sync"],
  },
  {
    slug: "connect-device",
    category: "account",
    title: ["Connect another device", "Connecter un autre appareil"],
    summary: [
      "Approve a new device and open the same encrypted vault.",
      "Autorisez un nouvel appareil et ouvrez le même coffre chiffré.",
    ],
    sections: [
      {
        id: "sign-in",
        title: ["Start on the new device", "Commencer sur le nouvel appareil"],
        text: [
          "Start account sign-in in the app. It opens a browser verification page and returns to Sub Rosa through its app link. Confirm that the code shown by the app matches the browser before approving it.",
          "Lancez la connexion au compte dans l’app. Elle ouvre une page de vérification dans le navigateur, puis revient à Sub Rosa par son lien d’app. Vérifiez que le code affiché dans l’app correspond à celui du navigateur avant de l’autoriser.",
        ],
      },
      {
        id: "approve",
        title: ["Unlock the shared vault", "Déverrouiller le coffre partagé"],
        text: [
          "If you already have an authorized device, use its pairing offer first. Otherwise use the recovery kit. Sync is optional: data stays local until you consent to connect it. Keep both devices available until the transfer completes.",
          "Si vous disposez déjà d’un appareil autorisé, utilisez d’abord sa proposition de jumelage. Sinon, utilisez le kit de récupération. La synchronisation est facultative : les données restent locales jusqu’à votre accord pour les connecter. Gardez les deux appareils disponibles jusqu’à la fin du transfert.",
        ],
      },
    ],
    related: ["account", "recovery", "sync"],
  },
  {
    slug: "recovery",
    category: "account",
    title: ["Keep and use your recovery kit", "Conserver et utiliser son kit de récupération"],
    summary: [
      "Protect the key that opens encrypted content on a new device.",
      "Protégez la clé qui ouvre le contenu chiffré sur un nouvel appareil.",
    ],
    sections: [
      {
        id: "keep",
        title: ["Store it safely", "Le conserver en sécurité"],
        text: [
          "Save your recovery kit when the vault is created and confirm that you can retrieve it. A password manager or other secure offline record is appropriate. Sub Rosa support cannot recover the key or decrypt your vault.",
          "Enregistrez votre kit de récupération lors de la création du coffre et vérifiez que vous pouvez le retrouver. Un gestionnaire de mots de passe ou un autre support hors ligne sûr convient. L’assistance Sub Rosa ne peut pas retrouver la clé ni déchiffrer votre coffre.",
        ],
      },
      {
        id: "restore",
        title: ["Use it when needed", "L’utiliser si nécessaire"],
        text: [
          "Use the kit to open the vault on a device that cannot pair with an existing one. Account email recovery restores access to the account, not to encrypted content. If the kit and all authorized devices are lost, existing encrypted data cannot be opened.",
          "Utilisez le kit pour ouvrir le coffre sur un appareil qui ne peut pas être jumelé à un appareil existant. La récupération par e-mail rétablit l’accès au compte, pas au contenu chiffré. Si le kit et tous les appareils autorisés sont perdus, les données chiffrées existantes ne peuvent plus être ouvertes.",
        ],
      },
    ],
    related: ["connect-device", "sync"],
  },
  {
    slug: "sync",
    category: "account",
    title: ["Understand encrypted sync", "Comprendre la synchronisation chiffrée"],
    summary: [
      "Know what moves between devices and what remains local.",
      "Sachez ce qui passe entre les appareils et ce qui reste local.",
    ],
    sections: [
      {
        id: "what",
        title: ["What sync does", "Ce que fait la synchronisation"],
        text: [
          "When enabled, compatible notes, conversations, files and settings are encrypted on your device before upload. The account service stores identity, sessions and encrypted objects; it does not run your AI requests or hold a readable copy of your saved provider key.",
          "Lorsqu’elle est activée, les notes, conversations, fichiers et réglages compatibles sont chiffrés sur votre appareil avant l’envoi. Le service de compte stocke l’identité, les sessions et les objets chiffrés ; il n’exécute pas vos requêtes d’IA et ne détient pas de copie lisible de votre clé fournisseur enregistrée.",
        ],
      },
      {
        id: "limits",
        title: ["Check the limits", "Connaître les limites"],
        text: [
          "Check sync status on each device after changes. A conflicting note preserves versions for review. Incoming history does not restart paid work. Revoking a device blocks its service session, but cannot erase copies it already downloaded or rotate the current shared vault key.",
          "Vérifiez l’état de synchronisation sur chaque appareil après une modification. Une note en conflit conserve les versions pour examen. Un historique reçu ne relance pas de travail payant. Révoquer un appareil bloque sa session sur le service, mais ne peut ni effacer les copies déjà téléchargées ni changer la clé actuelle du coffre partagé.",
        ],
      },
    ],
    related: ["connect-device", "recovery", "usage-privacy"],
  },
  {
    slug: "share-note",
    category: "account",
    title: ["Share a note", "Partager une note"],
    summary: [
      "Create a time-limited reading link for someone else.",
      "Créez un lien de lecture limité dans le temps pour une autre personne.",
    ],
    sections: [
      {
        id: "create",
        title: ["Create the link", "Créer le lien"],
        text: [
          "Open a note and choose Share this note. Select how long the link should work, then create and copy it. The recipient can read the shared note in a browser without opening your full account.",
          "Ouvrez une note et choisissez Partager cette note. Choisissez la durée de validité du lien, puis créez-le et copiez-le. Le destinataire peut lire la note partagée dans un navigateur sans ouvrir votre compte entier.",
        ],
        steps: [
          [
            "Review the note for private information before sharing.",
            "Relisez la note pour repérer les informations privées avant de la partager.",
          ],
          [
            "Choose an expiry and send the resulting link only to the intended reader.",
            "Choisissez une expiration et envoyez le lien obtenu uniquement au destinataire prévu.",
          ],
        ],
      },
      {
        id: "security",
        title: ["Know who can read it", "Savoir qui peut le lire"],
        text: [
          "Anyone who has the complete link can read the note until it expires. The service stores the share encrypted and does not receive the key carried by the link. A recipient may still copy what they see, so expiry cannot retract copies already made.",
          "Toute personne qui possède le lien complet peut lire la note jusqu’à son expiration. Le service conserve le partage chiffré et ne reçoit pas la clé portée par le lien. Un destinataire peut toutefois copier ce qu’il voit : l’expiration ne retire pas les copies déjà faites.",
        ],
      },
    ],
    related: ["account", "usage-privacy"],
  },
  {
    slug: "shortcuts",
    category: "reference",
    title: ["Use shortcuts", "Utiliser les raccourcis"],
    summary: [
      "Start recording, dictation or chat in one action.",
      "Lancez l’enregistrement, la dictée ou le chat en une action.",
    ],
    sections: [
      {
        id: "iphone",
        title: ["On iPhone", "Sur iPhone"],
        text: [
          "In the Shortcuts app, search for Sub Rosa. Its actions can start a new audio note, begin dictation or prepare a question for chat. Add one to a widget, the Home Screen or the Action button if your device supports it.",
          "Dans l’app Raccourcis, recherchez Sub Rosa. Ses actions peuvent créer une note audio, commencer une dictée ou préparer une question pour le chat. Ajoutez-en une à un widget, à l’écran d’accueil ou au bouton Action si votre appareil le permet.",
        ],
      },
      {
        id: "other",
        title: ["On other devices", "Sur les autres appareils"],
        text: [
          "Open Settings, then Shortcuts to copy a supported Sub Rosa address. Use it in an Open URL automation. Keep the address intact; a chat address may include text for a prefilled question, but it does not send the question until you choose to.",
          "Ouvrez Réglages, puis Raccourcis pour copier une adresse Sub Rosa prise en charge. Utilisez-la dans une automatisation Ouvrir l’URL. Gardez l’adresse intacte ; une adresse de chat peut inclure le texte d’une question préparée, mais elle ne l’envoie pas avant votre choix.",
        ],
      },
    ],
    related: ["record", "dictation", "agent"],
  },
  {
    slug: "usage-privacy",
    category: "reference",
    title: ["Privacy, credits and data", "Confidentialité, crédits et données"],
    summary: [
      "See where your data goes and what a model request costs.",
      "Voyez où vont vos données et ce que coûte une requête au modèle.",
    ],
    sections: [
      {
        id: "local",
        title: ["Local work and model requests", "Travail local et requêtes aux modèles"],
        text: [
          "Notes and recordings begin on your device. AI features send the data needed for that request to your configured Carpe Diem endpoint. Check Privacy settings for the destinations relevant to a feature. The optional account service stores encrypted sync data and account metadata, not plaintext notes.",
          "Les notes et enregistrements commencent sur votre appareil. Les fonctions d’IA envoient les données nécessaires à la requête à votre adresse Carpe Diem configurée. Consultez les réglages Confidentialité pour connaître les destinations d’une fonction. Le service de compte facultatif stocke les données synchronisées chiffrées et les métadonnées du compte, pas les notes en clair.",
        ],
      },
      {
        id: "credits",
        title: ["Credits and usage", "Crédits et consommation"],
        text: [
          "Carpe Diem meters model use separately from the Sub Rosa account. Studio shows a quote before paid generation. Usage and balance views report known requests and dated snapshots; missing data is not zero consumption. Check the provider balance directly when you need the current amount.",
          "Carpe Diem comptabilise l’utilisation des modèles séparément du compte Sub Rosa. Studio affiche un devis avant une génération payante. Les vues de consommation et de solde présentent les requêtes connues et des instantanés datés ; une donnée absente ne signifie pas une consommation nulle. Vérifiez directement le solde fournisseur lorsque vous avez besoin du montant actuel.",
        ],
      },
      {
        id: "export",
        title: ["Export or delete", "Exporter ou supprimer"],
        text: [
          "Export notes from the app before deleting an account. Account deletion revokes sessions and removes synced data, but local copies and your separate Carpe Diem account are not automatically deleted.",
          "Exportez les notes depuis l’app avant de supprimer un compte. La suppression du compte révoque les sessions et retire les données synchronisées, mais les copies locales et votre compte Carpe Diem distinct ne sont pas supprimés automatiquement.",
        ],
      },
    ],
    related: ["carpe-diem-key", "sync"],
  },
  {
    slug: "troubleshooting",
    category: "reference",
    title: ["Solve common problems", "Résoudre les problèmes courants"],
    summary: [
      "Work through connection, processing and sync issues.",
      "Résolvez les problèmes de connexion, de traitement et de synchronisation.",
    ],
    sections: [
      {
        id: "key",
        title: ["AI requests do not start", "Les requêtes d’IA ne démarrent pas"],
        text: [
          "Check the Carpe Diem base URL, key status and provider balance in Settings. A failed network request can leave local notes intact. Retry only after checking whether the previous paid operation completed.",
          "Vérifiez l’adresse de base Carpe Diem, l’état de la clé et le solde fournisseur dans Réglages. Une requête réseau échouée peut laisser les notes locales intactes. Ne réessayez qu’après avoir vérifié si l’opération payante précédente s’est terminée.",
        ],
      },
      {
        id: "note",
        title: ["A note is still processing", "Une note est encore en cours de traitement"],
        text: [
          "Open the note and inspect its status. Check connectivity and your key, then use the retry control if the app offers one. For an import, unsupported audio or a missing published stream can prevent decoding. Do not delete source material until the note is ready.",
          "Ouvrez la note et consultez son état. Vérifiez la connexion et votre clé, puis utilisez la commande de nouvelle tentative si l’app la propose. Pour un import, un audio non pris en charge ou un flux publié absent peut empêcher le décodage. Ne supprimez pas le contenu source avant que la note soit prête.",
        ],
      },
      {
        id: "sync",
        title: ["Devices disagree", "Les appareils divergent"],
        text: [
          "Check account and sync status on both devices. Keep them online long enough to exchange pending changes. Review a displayed conflict instead of discarding either version. If a device was revoked, reconnect it explicitly only if you still trust it.",
          "Vérifiez l’état du compte et de la synchronisation sur les deux appareils. Laissez-les connectés assez longtemps pour échanger les modifications en attente. Examinez un conflit affiché plutôt que d’écarter une version. Si un appareil a été révoqué, reconnectez-le explicitement seulement si vous lui faites encore confiance.",
        ],
      },
      {
        id: "support",
        title: ["Report a problem", "Signaler un problème"],
        text: [
          "Use the project issue tracker for a reproducible problem. Include the app version, device and steps you took. Never post API keys, recovery keys or private notes in a public issue.",
          "Utilisez le suivi des problèmes du projet pour un problème reproductible. Indiquez la version de l’app, l’appareil et les étapes suivies. Ne publiez jamais de clé API, de clé de récupération ni de note privée dans un ticket public.",
        ],
      },
    ],
    related: ["carpe-diem-key", "sync", "import"],
  },
];

export const guideBySlug = (slug: string) => guides.find((guide) => guide.slug === slug);

export function searchGuides(query: string) {
  const normalized = (value: string) =>
    value
      .toLocaleLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");
  const words = normalized(query.trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return guides;
  return guides.filter((guide) => {
    const haystack = [
      guide.title,
      guide.summary,
      ...guide.sections.flatMap((section) => [
        section.title,
        section.text,
        ...(section.steps ?? []),
      ]),
    ]
      .map(read)
      .join(" ")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
