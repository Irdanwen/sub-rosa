import { t, number } from "../lib/i18n";
import releases from "../releases.json";

export function Downloads() {
  const titles: Record<string, string> = {
    "mac-arm": "Mac · Apple Silicon",
    "mac-intel": "Mac · Intel",
    windows: "Windows · 64 bits",
  };
  return (
    <section className="page wrap">
      <p className="eyebrow">Sub Rosa {releases.version}</p>
      <h1>{t("Make it your space.", "Faites-en votre espace.")}</h1>
      <p className="lede">
        {import.meta.env.VITE_PREVIEW_ONLY === "1"
          ? t(
              "Start locally with your Carpe Diem key. Version 1.63.0 adds optional encrypted sync with a configured account service. Public account registration is not open yet.",
              "Commencez localement avec votre clé Carpe Diem. La version 1.63.0 ajoute la synchronisation chiffrée facultative avec un service de compte configuré. Les inscriptions publiques ne sont pas encore ouvertes.",
            )
          : t(
              "Download the app for your device. You can start locally, then connect your account when you are ready.",
              "Téléchargez l’app pour votre appareil. Commencez localement, puis connectez votre compte quand vous le souhaitez.",
            )}
      </p>
      <div className="grid">
        {releases.assets.map((asset) => (
          <article className="card" key={asset.platform}>
            <h2>{titles[asset.platform]}</h2>
            <p className="muted">
              {asset.platform === "mac-arm"
                ? t("For Macs with an Apple M chip.", "Pour les Mac équipés d’une puce Apple M.")
                : asset.platform === "mac-intel"
                  ? t(
                      "For Macs with an Intel processor.",
                      "Pour les Mac équipés d’un processeur Intel.",
                    )
                  : t(
                      "Installer for 64-bit Windows PCs.",
                      "Installateur pour les PC Windows 64 bits.",
                    )}
            </p>
            <a className="button primary" href={asset.url}>
              {t("Download", "Télécharger")} <span aria-hidden="true">↓</span>
            </a>
            <span className="download-meta">
              {number(asset.bytes / 1e6, 1)} MB · {releases.version}
            </span>
            <p className="quiet">
              {asset.platform === "windows"
                ? t(
                    "This version is not code-signed. Windows may display a warning.",
                    "Cette version n’est pas signée. Windows peut afficher un avertissement.",
                  )
                : t("Signed and notarized for macOS.", "Signée et notarisée pour macOS.")}
            </p>
            {asset.sha256 && (
              <details>
                <summary>{t("Verify download", "Vérifier le téléchargement")}</summary>
                <p className="quiet">SHA-256</p>
                <code className="hash">{asset.sha256}</code>
              </details>
            )}
          </article>
        ))}
      </div>
      <article className="card row">
        <div>
          <h2>iPhone</h2>
          <p className="muted">
            {t(
              "The iPhone app is currently distributed through TestFlight. Public access has not opened here yet.",
              "L’app iPhone est actuellement distribuée via TestFlight. L’accès public n’est pas encore ouvert ici.",
            )}
          </p>
        </div>
        <span className="notice">{t("TestFlight access", "Accès TestFlight")}</span>
      </article>
      <p className="quiet">
        <a href={releases.release_url}>
          {t("Read the release notes", "Lire les notes de version")} ↗
        </a>
      </p>
    </section>
  );
}

export function Information({ path }: { path: string }) {
  if (path === "/help")
    return (
      <section className="page wrap prose">
        <h1>{t("A little help.", "Un peu d’aide.")}</h1>
        <h2>{t("Get started", "Premiers pas")}</h2>
        <ol>
          <li>
            {t(
              "Download and install Sub Rosa for your device.",
              "Téléchargez et installez Sub Rosa pour votre appareil.",
            )}
          </li>
          <li>
            {t(
              "Add a Carpe Diem key in the app to use AI features.",
              "Ajoutez une clé Carpe Diem dans l’app pour utiliser les fonctions d’IA.",
            )}
          </li>
          <li>
            {t(
              "If you have a Sub Rosa account service, enter its HTTPS address in Settings to connect your devices with encrypted sync.",
              "Si vous disposez d’un service de compte Sub Rosa, saisissez son adresse HTTPS dans les Réglages pour connecter vos appareils avec la synchronisation chiffrée.",
            )}
          </li>
        </ol>
        <h2>{t("Connect another device", "Connecter un autre appareil")}</h2>
        <p>
          {t(
            "Start sign-in in the app. Open the verification page and confirm that the displayed code matches. Then open your vault using your recovery kit.",
            "Démarrez la connexion dans l’app. Ouvrez la page de vérification et confirmez que le code affiché correspond. Ouvrez ensuite votre coffre avec votre kit de récupération.",
          )}
        </p>
        <h2>{t("Something is missing", "Il manque quelque chose")}</h2>
        <p>
          {t(
            "Check sync status on both devices. A task that needs your computer will wait until it is available. A conflicted note keeps both versions so you can choose what to retain.",
            "Vérifiez l’état de synchronisation sur les deux appareils. Une tâche qui a besoin de votre ordinateur attend sa disponibilité. Une note en conflit conserve les deux versions pour vous laisser choisir.",
          )}
        </p>
        <h2>{t("Contact support", "Contacter l’assistance")}</h2>
        <p>
          {t(
            "Report a problem on the project tracker. Do not include API keys, private notes or recovery keys in a public report.",
            "Signalez un problème dans le suivi du projet. N’incluez aucune clé API, note privée ou clé de récupération dans un rapport public.",
          )}
        </p>
        <a className="button" href="https://github.com/Irdanwen/sub-rosa/issues">
          {t("Open support", "Ouvrir l’assistance")} ↗
        </a>
      </section>
    );
  if (path === "/security")
    return (
      <section className="page wrap prose">
        <h1>{t("Security, explained.", "La sécurité, expliquée.")}</h1>
        <h2>{t("Your vault", "Votre coffre")}</h2>
        <p>
          {t(
            "Your apps encrypt synced content before uploading it. The service stores encrypted objects and does not hold your recovery key. Account access alone does not decrypt them.",
            "Vos apps chiffrent les contenus synchronisés avant leur envoi. Le service stocke des objets chiffrés et ne détient pas votre clé de récupération. L’accès au compte seul ne permet pas de les déchiffrer.",
          )}
        </p>
        <h2>{t("Your browser", "Votre navigateur")}</h2>
        <p>
          {t(
            "Opening the vault on the web trusts the code delivered by this site. Keys stay in this tab’s memory and the vault locks after inactivity. Browser extensions and a compromised device can still access sensitive information.",
            "Ouvrir le coffre sur le web suppose de faire confiance au code livré par ce site. Les clés restent dans la mémoire de cet onglet et le coffre se verrouille après inactivité. Des extensions de navigateur ou un appareil compromis peuvent toujours accéder à des informations sensibles.",
          )}
        </p>
        <h2>{t("Lost device", "Appareil perdu")}</h2>
        <p>
          {t(
            "Revoke the device from your account. If it held your Carpe Diem key, replace that key with Carpe Diem too. Revocation cannot erase copies already downloaded.",
            "Révoquez l’appareil depuis votre compte. S’il détenait votre clé Carpe Diem, remplacez aussi cette clé auprès de Carpe Diem. La révocation ne peut pas effacer les copies déjà téléchargées.",
          )}
        </p>
        <p>
          {t(
            "Revocation blocks service access but does not replace the vault encryption key. A revoked device that obtains a later copy of encrypted data through another leak may still decrypt it.",
            "La révocation bloque l’accès au service mais ne remplace pas la clé de chiffrement du coffre. Un appareil révoqué qui obtiendrait ultérieurement des données chiffrées par une autre fuite pourrait encore les déchiffrer.",
          )}
        </p>
        <h2>{t("Report a vulnerability", "Signaler une vulnérabilité")}</h2>
        <p>
          {t(
            "Follow the security reporting instructions in the source repository. Avoid public disclosure of exploitable details before a fix is available.",
            "Suivez les instructions de signalement de sécurité du dépôt source. Évitez de publier des détails exploitables avant qu’une correction soit disponible.",
          )}
        </p>
        <a className="text-link" href="https://github.com/Irdanwen/sub-rosa/security/policy">
          {t("Security policy", "Politique de sécurité")} ↗
        </a>
      </section>
    );
  if (path === "/privacy")
    return (
      <section className="page wrap prose">
        <h1>{t("Your information stays yours.", "Vos informations restent les vôtres.")}</h1>
        <p className="lede">
          {t(
            "Choose whether to work locally or connect your devices with encrypted sync.",
            "Choisissez de travailler localement ou de réunir vos appareils avec la synchronisation chiffrée.",
          )}
        </p>
        <h2>{t("Without an account", "Sans compte")}</h2>
        <p>
          {t(
            "Your notes and recordings stay on your device. Requests needed for AI features are sent to the Carpe Diem endpoint you configured. The app explains these destinations in Privacy settings.",
            "Vos notes et enregistrements restent sur votre appareil. Les requêtes nécessaires aux fonctions d’IA sont envoyées à l’adresse Carpe Diem que vous avez configurée. L’app présente ces destinations dans les réglages Confidentialité.",
          )}
        </p>
        <h2>{t("With sync enabled", "Avec la synchronisation activée")}</h2>
        <p>
          {t(
            "The service stores your account identity, connected devices, session and security information, and encrypted content. Network addresses, transfer times and sizes are visible to infrastructure operators. Note text and your saved Carpe Diem key are encrypted before upload.",
            "Le service stocke l’identité de votre compte, les appareils connectés, les informations de session et de sécurité, ainsi que les contenus chiffrés. Les adresses réseau, horaires et volumes de transfert sont visibles pour les opérateurs d’infrastructure. Le texte des notes et votre clé Carpe Diem enregistrée sont chiffrés avant l’envoi.",
          )}
        </p>
        <h2>{t("Cookies", "Cookies")}</h2>
        <p>
          {t(
            "The account uses essential session and request-protection cookies. This website does not include advertising trackers or session replay.",
            "Le compte utilise des cookies essentiels de session et de protection des requêtes. Ce site n’intègre ni traqueur publicitaire ni enregistrement de session.",
          )}
        </p>
        <h2>{t("Export and deletion", "Export et suppression")}</h2>
        <p>
          {t(
            "Export your notes from the app. Delete your Sub Rosa account from account settings to revoke sessions and remove synced data. Local copies and your separate Carpe Diem account are not automatically deleted.",
            "Exportez vos notes depuis l’app. Supprimez votre compte Sub Rosa depuis ses réglages pour révoquer les sessions et retirer les données synchronisées. Les copies locales et votre compte Carpe Diem distinct ne sont pas supprimés automatiquement.",
          )}
        </p>
        <p className="notice">
          {t(
            "This service is being prepared for release. Operator details, hosting regions and retention periods must be published before public account registration opens.",
            "Ce service est en préparation. L’identité de l’exploitant, les régions d’hébergement et les durées de conservation doivent être publiées avant l’ouverture publique des inscriptions.",
          )}
        </p>
      </section>
    );
  return (
    <section className="page wrap">
      <h1>{t("Page not found", "Page introuvable")}</h1>
      <p>
        {t(
          "This address does not point to a page on Sub Rosa.",
          "Cette adresse ne correspond à aucune page Sub Rosa.",
        )}
      </p>
      <a className="button" href="/">
        {t("Back to home", "Retour à l’accueil")}
      </a>
    </section>
  );
}
