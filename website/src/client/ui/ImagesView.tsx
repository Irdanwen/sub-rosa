import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { number, t } from "../../lib/i18n";
import { canvasImageFitter, visionModelFor } from "../attachments";
import { CarpeDiemError } from "../carpe-diem";
import { AGENT_LITE } from "../codec";
import { saveToGallery } from "../gallery";
import {
  editImage,
  generateImage,
  type ImageCall,
  imageModels,
  type JobKeeper,
  type PendingJob,
  type Picture,
  pollJob,
  refineEditModel,
  tryOn,
  tryOnModel,
} from "../images";
import { refine } from "../refine";
import type { ClientContext } from "./context";

type Tab = "generate" | "edit" | "tryon";
type Shown = Picture & { id: string; filed?: boolean; note?: string };

const ASPECTS = ["1:1", "4:3", "3:4", "16:9", "9:16"];

function priceLabel(credits: number | undefined): string {
  return credits === undefined
    ? t("price not published", "prix non publié")
    : t(`${number(credits)} credits`, `${number(credits)} crédits`);
}

function failure(error: unknown): string {
  if (error instanceof CarpeDiemError) {
    if (error.code === "KEY_DAILY_CAP")
      return t(
        "This browser has spent its daily allowance. Try again later, or continue in the app.",
        "Ce navigateur a dépensé son allocation du jour. Réessayez plus tard, ou continuez dans l’app.",
      );
    if (error.status === 402)
      return t(
        "Your Carpe Diem balance is empty. Top up, then try again.",
        "Votre solde Carpe Diem est vide. Rechargez, puis réessayez.",
      );
    if (error.code === "still_pending")
      return t(
        "The picture is still being made. Reopen this page later to fetch it.",
        "L’image est encore en cours. Rouvrez cette page plus tard pour la récupérer.",
      );
    return t(
      `The picture could not be made: ${error.message}`,
      `L’image n’a pas pu être créée : ${error.message}`,
    );
  }
  return t(
    "The picture could not be made. Check your connection and try again.",
    "L’image n’a pas pu être créée. Vérifiez votre connexion et réessayez.",
  );
}

/**
 * Pictures from the browser (ADR-0088): generate, edit, try on, and the
 * "check and fix" pass that looks at a picture and corrects it, with the most
 * it can cost shown before it runs. Every picture is filed in the account's
 * gallery, as one made in the app is.
 */
export function ImagesView({
  ctx,
  garment,
}: {
  ctx: ClientContext;
  /** The garment a try-on card named, when one opened this view. */
  garment?: string;
}) {
  const generators = useMemo(() => imageModels("image", ctx.live), [ctx.live]);
  const editors = useMemo(() => imageModels("imageEdit", ctx.live), [ctx.live]);
  const [tab, setTab] = useState<Tab>(garment !== undefined ? "tryon" : "generate");
  const [model, setModel] = useState("");
  const [editModel, setEditModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState("1:1");
  const [check, setCheck] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const [garmentPhoto, setGarmentPhoto] = useState<string | null>(null);
  const [garmentLabel, setGarmentLabel] = useState(garment ?? "");
  const [results, setResults] = useState<Shown[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (garment !== undefined) {
      setTab("tryon");
      setGarmentLabel(garment);
    }
  }, [garment]);
  const generator = generators.find((item) => item.id === model) ?? generators[0];
  const editor = editors.find((item) => item.id === editModel) ?? refineEditModel(editors);
  const tryOnWith = tryOnModel(editors);
  const passes = AGENT_LITE.editing.refine.maxPasses;
  const visionModel = visionModelFor(
    ctx.models.map((item) => ({ ...item, supportsVision: item.supportsVision })),
    ctx.model,
  );

  const keeper: JobKeeper = useMemo(
    () => ({
      keep: async (job) => {
        const jobs = (await ctx.local?.pendingImages()) ?? [];
        await ctx.local?.setPendingImages([...jobs, job]);
      },
      done: async (queueId) => {
        const jobs = (await ctx.local?.pendingImages()) ?? [];
        await ctx.local?.setPendingImages(jobs.filter((job) => job.queueId !== queueId));
      },
    }),
    [ctx.local],
  );

  const file = useCallback(
    async (picture: Picture, note?: string) => {
      const id = crypto.randomUUID();
      setResults((value) => [{ ...picture, id, note }, ...value]);
      try {
        await saveToGallery(ctx.sync, ctx.account.id, ctx.vaultKey, picture);
        ctx.flush();
        setResults((value) =>
          value.map((item) => (item.id === id ? { ...item, filed: true } : item)),
        );
      } catch {
        setError(
          t(
            "The picture was made, but could not be filed in your gallery.",
            "L’image a été créée, mais n’a pas pu être rangée dans votre galerie.",
          ),
        );
      }
    },
    [ctx],
  );

  // A job queued before a reload is fetched, never paid for again, and only
  // once per visit to this view. A picture that lands after the view closed
  // is still filed in the gallery.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    void (async () => {
      const jobs: PendingJob[] = (await ctx.local?.pendingImages()) ?? [];
      if (!jobs.length) return;
      const key = await ctx.openKey().catch(() => null);
      if (!key) return;
      for (const job of jobs)
        pollJob({ operator: ctx.operator, key, keeper }, job)
          .then((dataUrl) => file({ dataUrl, model: job.model, prompt: job.prompt }))
          .catch(() => undefined);
    })();
  }, [ctx, keeper, file]);

  const call = async (): Promise<ImageCall | null> => {
    const key = await ctx.openKey().catch(() => null);
    if (!key) {
      setError(
        t(
          "This browser has no Carpe Diem key yet. Get one from your devices page.",
          "Ce navigateur n’a pas encore de clé Carpe Diem. Obtenez-en une depuis la page de vos appareils.",
        ),
      );
      return null;
    }
    controller.current = new AbortController();
    return { operator: ctx.operator, key, signal: controller.current.signal, keeper };
  };

  const run = async (work: (call: ImageCall) => Promise<void>, label: string) => {
    setError("");
    const request = await call();
    if (!request) return;
    setBusy(label);
    try {
      await work(request);
    } catch (failed) {
      if (!request.signal?.aborted) setError(failure(failed));
    } finally {
      setBusy("");
    }
  };

  const make = () =>
    run(
      async (request) => {
        if (!generator) return;
        const picture = await generateImage(request, {
          model: generator.id,
          prompt,
          aspectRatio: aspect,
        });
        if (!check || !editor || !visionModel) return file(picture);
        await file(picture, t("First version", "Première version"));
        await refine(request, {
          visionModel,
          editModel: editor.id,
          picture,
          onStep: (step) => {
            if (step.picture)
              void file(
                step.picture,
                t(
                  `Fixed: ${step.critique.issues.join("; ")}`,
                  `Corrigé : ${step.critique.issues.join(" ; ")}`,
                ),
              );
            else
              setBusy(
                t(
                  "The picture already does what you asked.",
                  "L’image fait déjà ce que vous avez demandé.",
                ),
              );
          },
        });
      },
      t("Making the picture…", "Création de l’image…"),
    );

  const pickPhoto = async (files: FileList | null, set: (value: string) => void) => {
    const picked = files?.[0];
    if (!picked) return;
    try {
      set(await canvasImageFitter(picked));
    } catch {
      setError(t("This picture could not be read.", "Cette image n’a pas pu être lue."));
    }
  };

  const tabs: [Tab, string][] = [
    ["generate", t("Create", "Créer")],
    ["edit", t("Edit", "Retoucher")],
    ["tryon", t("Try on", "Essayer")],
  ];
  return (
    <section className="wc-view" aria-labelledby="wc-images-title">
      <h1 id="wc-images-title">{t("Pictures", "Images")}</h1>
      <fieldset className="wc-tabs">
        <legend className="sr-only">{t("What to do", "Que faire")}</legend>
        {tabs.map(([id, label]) => (
          <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </fieldset>
      <div className="form">
        {tab === "generate" && (
          <>
            <label>
              <span>{t("Model", "Modèle")}</span>
              <select
                value={generator?.id ?? ""}
                onChange={(event) => setModel(event.target.value)}
              >
                {generators.map((item) => (
                  <option key={item.id} value={item.id}>
                    {`${item.name} (${priceLabel(item.credits)})`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("Describe the picture", "Décrivez l’image")}</span>
              <textarea
                rows={3}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            <label>
              <span>{t("Shape", "Format")}</span>
              <select value={aspect} onChange={(event) => setAspect(event.target.value)}>
                {ASPECTS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={check}
                disabled={!editor || !visionModel}
                onChange={(event) => setCheck(event.target.checked)}
              />
              {t(
                "Check the picture and fix what is wrong",
                "Vérifier l’image et corriger ce qui ne va pas",
              )}
            </label>
            {check && editor && (
              <p className="quiet">
                {editor.credits === undefined
                  ? t(
                      `Sub Rosa checks the picture against your prompt and fixes what is wrong, with up to ${passes} edits. The price of an edit is not published.`,
                      `Sub Rosa compare l’image à votre demande et corrige ce qui ne va pas, en ${passes} retouches au plus. Le prix d’une retouche n’est pas publié.`,
                    )
                  : t(
                      `Sub Rosa checks the picture against your prompt and fixes what is wrong, with up to ${passes} edits. At most ${priceLabel(editor.credits * passes)}, nothing for a check that finds nothing to fix.`,
                      `Sub Rosa compare l’image à votre demande et corrige ce qui ne va pas, en ${passes} retouches au plus. Au plus ${priceLabel(editor.credits * passes)}, rien si la vérification ne trouve rien à corriger.`,
                    )}
              </p>
            )}
            <button
              className="button primary"
              type="button"
              disabled={!prompt.trim() || !generator || !!busy}
              onClick={() => void make()}
            >
              {generator
                ? t(
                    `Create for ${priceLabel(generator.credits)}`,
                    `Créer pour ${priceLabel(generator.credits)}`,
                  )
                : t("Create", "Créer")}
            </button>
          </>
        )}
        {tab === "edit" && (
          <>
            <label>
              <span>{t("Picture to edit", "Image à retoucher")}</span>
              <input
                type="file"
                accept="image/*"
                onChange={(event) => void pickPhoto(event.target.files, setSource)}
              />
            </label>
            {source && (
              <img
                className="wc-preview"
                src={source}
                alt={t("The picture to edit", "L’image à retoucher")}
              />
            )}
            <label>
              <span>{t("Model", "Modèle")}</span>
              <select
                value={editor?.id ?? ""}
                onChange={(event) => setEditModel(event.target.value)}
              >
                {editors.map((item) => (
                  <option key={item.id} value={item.id}>
                    {`${item.name} (${priceLabel(item.credits)})`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("What should change?", "Que faut-il changer ?")}</span>
              <textarea
                rows={3}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            <button
              className="button primary"
              type="button"
              disabled={!source || !prompt.trim() || !editor || !!busy}
              onClick={() =>
                void run(
                  async (request) => {
                    if (!source || !editor) return;
                    await file(
                      await editImage(request, { model: editor.id, prompt, image: source }),
                    );
                  },
                  t("Editing the picture…", "Retouche de l’image…"),
                )
              }
            >
              {editor
                ? t(
                    `Edit for ${priceLabel(editor.credits)}`,
                    `Retoucher pour ${priceLabel(editor.credits)}`,
                  )
                : t("Edit", "Retoucher")}
            </button>
          </>
        )}
        {tab === "tryon" && (
          <>
            <p className="quiet">
              {t(
                "A photo of a person and one of a garment, made into one picture of that person wearing it.",
                "Une photo d’une personne et une d’un vêtement, réunies en une image de cette personne qui le porte.",
              )}
            </p>
            <label>
              <span>{t("Photo of the person", "Photo de la personne")}</span>
              <input
                type="file"
                accept="image/*"
                onChange={(event) => void pickPhoto(event.target.files, setPerson)}
              />
            </label>
            <label>
              <span>{t("Photo of the garment", "Photo du vêtement")}</span>
              <input
                type="file"
                accept="image/*"
                onChange={(event) => void pickPhoto(event.target.files, setGarmentPhoto)}
              />
            </label>
            <label>
              <span>
                {t(
                  "The garment, in a few words (optional)",
                  "Le vêtement, en quelques mots (facultatif)",
                )}
              </span>
              <input
                value={garmentLabel}
                maxLength={160}
                onChange={(event) => setGarmentLabel(event.target.value)}
              />
            </label>
            {!tryOnWith && (
              <p className="quiet">
                {t(
                  "No model can do a try-on right now.",
                  "Aucun modèle ne peut faire d’essayage pour l’instant.",
                )}
              </p>
            )}
            <button
              className="button primary"
              type="button"
              disabled={!person || !garmentPhoto || !tryOnWith || !!busy}
              onClick={() =>
                void run(
                  async (request) => {
                    if (!person || !garmentPhoto || !tryOnWith) return;
                    await file(
                      await tryOn(request, {
                        model: tryOnWith.id,
                        person,
                        garment: garmentPhoto,
                        garmentLabel,
                      }),
                    );
                  },
                  t("Dressing the photo…", "Habillage de la photo…"),
                )
              }
            >
              {tryOnWith
                ? t(
                    `Try it on for ${priceLabel(tryOnWith.credits)}`,
                    `Essayer pour ${priceLabel(tryOnWith.credits)}`,
                  )
                : t("Try it on", "Essayer")}
            </button>
          </>
        )}
      </div>
      {busy && (
        <p className="quiet" role="status">
          {busy}{" "}
          <button className="button" type="button" onClick={() => controller.current?.abort()}>
            {t("Stop waiting", "Arrêter d’attendre")}
          </button>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {results.length > 0 && (
        <ul className="wc-gallery" aria-label={t("Pictures made here", "Images faites ici")}>
          {results.map((picture) => (
            <li key={picture.id}>
              <img src={picture.dataUrl} alt={picture.prompt} />
              {picture.note && <p className="quiet">{picture.note}</p>}
              <p className="quiet">
                {picture.filed
                  ? t("In your gallery", "Dans votre galerie")
                  : t("Filing in your gallery…", "Rangement dans votre galerie…")}
              </p>
              <div className="wc-actions">
                <a href={picture.dataUrl} download={`sub-rosa-${picture.id.slice(0, 8)}.png`}>
                  {t("Download", "Télécharger")}
                </a>
                <button
                  type="button"
                  onClick={() => {
                    setSource(picture.dataUrl);
                    setTab("edit");
                  }}
                >
                  {t("Edit this picture", "Retoucher cette image")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
