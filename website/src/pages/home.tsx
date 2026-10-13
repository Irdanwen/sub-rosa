import {
  FAMILY_COUNT,
  LANGUAGE_COUNT,
  PRICE_EXAMPLES,
  STUDIO_CREATION_CREDITS,
  STUDIO_CREATIONS,
} from "../home-facts";
import { number, t, type SiteLocale } from "../lib/i18n";
import { accountsUnavailable, localizedSiteHref, siteHref } from "../lib/paths";
import releases from "../releases.json";

/** One credit is one US cent; French keeps the singular below two. */
function credits(usd: number) {
  const value = Math.round(usd * 1000) / 10;
  const shown = value >= 5 ? Math.round(value) : value;
  return `${number(shown, 1)} ${t(shown === 1 ? "credit" : "credits", shown < 2 ? "crédit" : "crédits")}`;
}

/**
 * The home page: what the app is, shown rather than drawn. The pictures are
 * the real app (its interface, with creations made in its Studio), in the
 * reader's language and theme; every number is held to the model catalog by
 * src/test/website-home.test.tsx.
 */
export function HomePage({ locale }: { locale: SiteLocale }) {
  const href = (path: string) => localizedSiteHref(path, locale);
  // The captures exist in English and French; the other languages read the
  // English one, as the documentation's screenshots do.
  const shot = locale === "fr" ? "fr" : "en";
  return (
    <>
      <section className="hero wrap">
        <div className="hero-copy">
          <p className="eyebrow">
            {t(
              "Meeting notes, chat and studio, with private AI",
              "Notes de réunion, chat et studio, avec une IA privée",
            )}
          </p>
          <h1>
            {t("Keep the thread.", "Gardez le fil.")}
            <br />
            <em>{t("Make more of it.", "Allez plus loin.")}</em>
          </h1>
          <p className="intro">
            {t(
              "Record a meeting and get a clear note. Ask questions about everything you have written. Create images, voices and films. One app, on your computer.",
              "Enregistrez une réunion et obtenez une note claire. Interrogez tout ce que vous avez écrit. Créez des images, des voix et des films. Une seule app, sur votre ordinateur.",
            )}
          </p>
          <div className="actions">
            <a className="button primary" href={href("/downloads")}>
              {t("Download Sub Rosa", "Télécharger Sub Rosa")} <span aria-hidden="true">↗</span>
            </a>
            <a className="text-link" href={href("/account")}>
              {t("Go to your account", "Accéder à votre compte")} <span aria-hidden="true">→</span>
            </a>
          </div>
          <p className="platform-line">
            {releases.android
              ? t("For Mac, Windows and Android", "Sur Mac, Windows et Android")
              : t("For Mac and Windows", "Sur Mac et Windows")}{" "}
            <span aria-hidden="true">·</span> {t("Start locally", "Commencez en local")}
          </p>
        </div>
        <div className="hero-visual">
          <div className="visual-orbit orbit-one" />
          <div className="visual-orbit orbit-two" />
          <picture className="hero-shot">
            <source
              media="(prefers-color-scheme: dark)"
              srcSet={siteHref(`/home/home-${shot}-dark.webp`)}
            />
            <img
              src={siteHref(`/home/home-${shot}-light.webp`)}
              width={1600}
              height={1000}
              alt={t(
                "Sub Rosa on a computer: a new chat, with notes, projects, dictation and Studio in the sidebar",
                "Sub Rosa sur un ordinateur : un nouveau chat, avec les notes, les projets, la dictée et le Studio dans la barre latérale",
              )}
            />
          </picture>
        </div>
      </section>

      <section className="proof-strip" aria-label={t("Sub Rosa in facts", "Sub Rosa en faits")}>
        <div className="wrap proof-grid">
          <span>{t("Free and open source, MIT license", "Gratuit et libre, licence MIT")}</span>
          <span>{t("Signed and notarized for macOS", "Signée et notarisée pour macOS")}</span>
          <span>
            {t(
              `${number(FAMILY_COUNT)} model families to choose from`,
              `${number(FAMILY_COUNT)} familles de modèles au choix`,
            )}
          </span>
          <span>
            {t(`In ${number(LANGUAGE_COUNT)} languages`, `En ${number(LANGUAGE_COUNT)} langues`)}
          </span>
        </div>
      </section>

      <section className="story wrap">
        <div className="section-heading">
          <p className="eyebrow">{t("From moment to meaning", "Du moment à l’essentiel")}</p>
          <h2>
            {t("Your work has a life after the meeting.", "Vos idées vivent après la réunion.")}
          </h2>
          <p>
            {t(
              "Sub Rosa gives every conversation somewhere to go.",
              "Sub Rosa donne une suite à chaque conversation.",
            )}
          </p>
        </div>
        <div className="story-grid">
          <article className="story-card story-card-featured">
            <span className="story-number">01</span>
            <div className="waveform" aria-hidden="true">
              {Array.from({ length: 17 }, (_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: decorative bars with no identity
                <i key={index} />
              ))}
            </div>
            <h3>{t("Capture the conversation", "Saisissez la conversation")}</h3>
            <p>
              {t(
                "Record and transcribe, then turn what was said into a useful note.",
                "Enregistrez et transcrivez, puis transformez les échanges en une note utile.",
              )}
            </p>
          </article>
          <article className="story-card">
            <span className="story-number">02</span>
            <div className="story-symbol" aria-hidden="true">
              ✳
            </div>
            <h3>{t("Follow the idea", "Suivez l’idée")}</h3>
            <p>
              {t(
                "Write freely, ask questions of your notes and create in Studio.",
                "Écrivez librement, interrogez vos notes et créez dans Studio.",
              )}
            </p>
          </article>
          <article className="story-card">
            <span className="story-number">03</span>
            <div className="story-symbol" aria-hidden="true">
              ◎
            </div>
            <h3>
              {accountsUnavailable
                ? t("Your work stays yours", "Votre travail reste à vous")
                : t("Pick up anywhere", "Reprenez où vous voulez")}
            </h3>
            <p>
              {accountsUnavailable
                ? t(
                    "Keep working locally. Encrypted continuity will be available when public accounts open.",
                    "Continuez en local. Vous pourrez retrouver vos données chiffrées sur vos appareils à l’ouverture des comptes publics.",
                  )
                : t(
                    "Work locally. Connect your account when you want encrypted continuity across devices.",
                    "Travaillez en local. Connectez votre compte quand vous souhaitez retrouver vos données chiffrées sur vos appareils.",
                  )}
            </p>
          </article>
        </div>
      </section>

      <section className="studio-band">
        <div className="wrap studio-layout">
          <div className="studio-copy">
            <p className="eyebrow">{t("A wider canvas", "Un espace plus vaste")}</p>
            <h2>{t("A workspace for more than notes.", "Bien plus qu’un espace de notes.")}</h2>
            <p>
              {t(
                "Move from a passing thought to an image, a voice or a film in Studio. The result appears where you are looking, with its price next to the button.",
                "Passez d’une idée à une image, une voix ou un film dans Studio. Le résultat apparaît là où vous regardez, avec son prix à côté du bouton.",
              )}
            </p>
            <a className="text-link" href={href("/models/image")}>
              {t("The image models", "Les modèles d’image")} <span aria-hidden="true">→</span>
            </a>
          </div>
          <figure className="studio-frame">
            <img
              src={siteHref(`/home/studio-${shot}.webp`)}
              width={1600}
              height={1000}
              alt={t(
                "Sub Rosa Studio: an image made in the app, on the stage, above the prompt and the recent creations",
                "Le Studio de Sub Rosa : une image créée dans l’app, sur la scène, au-dessus du prompt et des créations récentes",
              )}
              loading="lazy"
            />
            <figcaption>{t("Studio in the app", "Studio dans l’app")}</figcaption>
          </figure>
        </div>
        <div className="wrap made-in-studio">
          <ul className="made-grid">
            {STUDIO_CREATIONS.map((creation) => (
              <li key={creation.file}>
                <img
                  src={siteHref(`/home/${creation.file}.webp`)}
                  width={720}
                  height={720}
                  alt={t(creation.en, creation.fr)}
                  loading="lazy"
                />
              </li>
            ))}
          </ul>
          <p className="made-note">
            {t(
              `Made in Studio with Flux 2 Pro, about ${credits(STUDIO_CREATION_CREDITS / 100)} each.`,
              `Créées dans Studio avec Flux 2 Pro, environ ${credits(STUDIO_CREATION_CREDITS / 100)} chacune.`,
            )}
          </p>
        </div>
      </section>

      <section className="pricing wrap">
        <div className="section-heading">
          <p className="eyebrow">{t("What it costs", "Ce que ça coûte")}</p>
          <h2>{t("Pay for what you use.", "Payez ce que vous utilisez.")}</h2>
          <p>
            {t(
              "The app is free. AI work is paid with Carpe Diem credits, one credit per US cent, without a subscription.",
              "L’app est gratuite. Le travail de l’IA se paie en crédits Carpe Diem, un crédit par centime de dollar, sans abonnement.",
            )}
          </p>
        </div>
        <ul className="price-grid">
          <li>
            <span>{t("An hour of meeting, transcribed", "Une heure de réunion, transcrite")}</span>
            <strong>
              {t(
                `About ${credits(PRICE_EXAMPLES.transcriptionHour.usd)}`,
                `Environ ${credits(PRICE_EXAMPLES.transcriptionHour.usd)}`,
              )}
            </strong>
          </li>
          <li>
            <span>{t("An image", "Une image")}</span>
            <strong>
              {t(
                `From ${credits(PRICE_EXAMPLES.image.usd)}`,
                `Dès ${credits(PRICE_EXAMPLES.image.usd)}`,
              )}
            </strong>
          </li>
          <li>
            <span>{t("A five-second video", "Une vidéo de cinq secondes")}</span>
            <strong>
              {t(
                `From ${credits(PRICE_EXAMPLES.clip.usd)}`,
                `Dès ${credits(PRICE_EXAMPLES.clip.usd)}`,
              )}
            </strong>
          </li>
        </ul>
        <p className="price-note">
          {t(
            "With the least expensive private model of each kind. Every model shows its own price in the catalog.",
            "Avec le modèle privé le moins cher de chaque type. Chaque modèle affiche son prix dans le catalogue.",
          )}{" "}
          <a className="text-link" href={href("/models")}>
            {t("Model catalog", "Catalogue des modèles")} <span aria-hidden="true">→</span>
          </a>
        </p>
      </section>

      <section className="privacy-story wrap">
        <div>
          <p className="eyebrow">{t("Your space, your decision", "Votre espace, votre choix")}</p>
          <h2>
            {t(
              "Start on your device. Connect on your terms.",
              "Commencez sur votre appareil. Connectez-vous à votre rythme.",
            )}
          </h2>
        </div>
        <div>
          <p>
            {accountsUnavailable
              ? t(
                  "Use Sub Rosa locally with your Carpe Diem key today. Optional encrypted sync will open after the account service is ready.",
                  "Utilisez Sub Rosa en local avec votre clé Carpe Diem dès aujourd’hui. La synchronisation chiffrée facultative ouvrira quand le service de compte sera prêt.",
                )
              : t(
                  "You can use Sub Rosa locally with your Carpe Diem key. An optional account brings encrypted content to your other devices when you decide to turn sync on.",
                  "Utilisez Sub Rosa en local avec votre clé Carpe Diem. Un compte facultatif vous permet de retrouver vos contenus chiffrés sur vos autres appareils, lorsque vous activez la synchronisation.",
                )}
          </p>
          <a className="text-link" href={href("/privacy")}>
            {t("How your data is handled", "Comment vos données sont traitées")}{" "}
            <span aria-hidden="true">→</span>
          </a>
        </div>
      </section>

      <section className="faq wrap" aria-labelledby="faq-title">
        <h2 id="faq-title">{t("Questions", "Questions")}</h2>
        <details>
          <summary>{t("Do I need a subscription?", "Faut-il un abonnement ?")}</summary>
          <p>
            {t(
              "No. The app is free and open source. You pay only for the AI work you ask for, in Carpe Diem credits.",
              "Non. L’app est gratuite et libre. Vous ne payez que le travail d’IA que vous demandez, en crédits Carpe Diem.",
            )}
          </p>
        </details>
        <details>
          <summary>{t("Where are my notes kept?", "Où sont gardées mes notes ?")}</summary>
          <p>
            {t(
              "On your computer. If you turn on sync, they are encrypted on your device before they leave it.",
              "Sur votre ordinateur. Si vous activez la synchronisation, elles sont chiffrées sur votre appareil avant de le quitter.",
            )}
          </p>
        </details>
        <details>
          <summary>
            {t("Which AI models can I use?", "Quels modèles d’IA puis-je utiliser ?")}
          </summary>
          <p>
            {t(
              `You choose the model for each task among ${number(FAMILY_COUNT)} families, from small private models to the strongest ones. The catalog describes each one.`,
              `Vous choisissez le modèle de chaque tâche parmi ${number(FAMILY_COUNT)} familles, des petits modèles privés aux plus puissants. Le catalogue présente chacun d’eux.`,
            )}{" "}
            <a className="text-link" href={href("/models")}>
              {t("Model catalog", "Catalogue des modèles")}
            </a>
          </p>
        </details>
        <details>
          <summary>
            {t("Does it work without a connection?", "Fonctionne-t-elle sans connexion ?")}
          </summary>
          <p>
            {t(
              "Writing, reading and recording, yes. Transcription, chat and Studio need a connection.",
              "Écrire, relire et enregistrer, oui. La transcription, le chat et le Studio demandent une connexion.",
            )}
          </p>
        </details>
        <details>
          <summary>{t("Which devices?", "Sur quels appareils ?")}</summary>
          <p>
            {releases.android
              ? t(
                  "Mac (Apple Silicon and Intel) and Windows. An Android version is available for testing.",
                  "Mac (Apple Silicon et Intel) et Windows. Une version Android est disponible en test.",
                )
              : t(
                  "Mac (Apple Silicon and Intel) and Windows.",
                  "Mac (Apple Silicon et Intel) et Windows.",
                )}
          </p>
        </details>
        <details>
          <summary>{t("Who makes Sub Rosa?", "Qui fait Sub Rosa ?")}</summary>
          <p>
            {t(
              "Lumen Labs, in Geneva. The code is public, and every release is built from it.",
              "Lumen Labs, à Genève. Le code est public, et chaque version est construite à partir de lui.",
            )}{" "}
            <a className="text-link" href={href("/legal")}>
              {t("Legal notice", "Mentions légales")}
            </a>
          </p>
        </details>
      </section>

      <section className="closing wrap">
        <div>
          <p className="eyebrow">{t("Begin here", "À vous de commencer")}</p>
          <h2>{t("Make space for what matters.", "Faites place à l’essentiel.")}</h2>
        </div>
        <a className="button primary" href={href("/downloads")}>
          {t("Get Sub Rosa", "Obtenir Sub Rosa")} <span aria-hidden="true">↗</span>
        </a>
      </section>
    </>
  );
}
