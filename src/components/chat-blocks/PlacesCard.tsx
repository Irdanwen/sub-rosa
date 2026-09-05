import { intlLocale, t } from "../../lib/i18n";
import { IconGlobe } from "central-icons/IconGlobe";
import { IconMinusMedium } from "central-icons/IconMinusMedium";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { useEffect, useRef, useState } from "react";
import type { ChatBlockPlace, PlacesChatBlock } from "../../lib/chat-blocks";
import {
  type LatLng,
  MAX_MAP_ZOOM,
  MIN_MAP_ZOOM,
  fitBounds,
  panCenter,
  pixelOffset,
} from "../../lib/map-projection";
import { openExternalUrl, placesPhotoDataUrl, renderMapCard } from "../../lib/tauri";

/** Logical map banner height; width follows the card. */
const MAP_HEIGHT = 200;
/** Pins closer than this to the edge are drawn anyway; further out, hidden. */
const PIN_MARGIN = 10;
/** Pointer travel below this is a click, not a drag. */
const DRAG_THRESHOLD = 4;

type MapView = { center: LatLng; zoom: number };

/**
 * The places chat block: a static map banner (rendered by Rust from OSM
 * tiles), DOM pins projected over it, and the list of places. Hovering a row
 * lights its pin and vice versa.
 *
 * The map is quietly interactive without any JS map library: zoom buttons
 * re-render at ±1, and a mouse drag translates the current image live, then
 * re-renders at the settled center on release — pins stay projected against
 * the view that produced the visible image, so they never drift from their
 * buildings while the next render is in flight. Touch keeps the buttons and
 * open-in-Maps (a touch drag must keep scrolling the conversation).
 *
 * Without a map at all (render failed, browser preview without a bridge),
 * the list stands alone — the card never blocks on the banner.
 */
export function PlacesCard({ block }: { block: PlacesChatBlock }) {
  const containerRef = useRef<HTMLElement>(null);
  const [mapWidth, setMapWidth] = useState<number | null>(null);
  /** The rendered image plus the exact view it shows (pins project on it). */
  const [mapState, setMapState] = useState<(MapView & { url: string }) | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  /** User override from zoom/pan; null means "fit the pins". */
  const [targetView, setTargetView] = useState<MapView | null>(null);
  /** Live drag translation, kept until the settled render lands. */
  const [dragOffset, setDragOffset] = useState({ dx: 0, dy: 0 });
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);
  const [hot, setHot] = useState<number | null>(null);

  useEffect(() => {
    const width = containerRef.current?.clientWidth;
    // Rounding keeps one render request per card width family and makes the
    // tile cache actually hit across cards.
    setMapWidth(width ? Math.max(240, Math.round(width / 20) * 20) : 480);
  }, []);

  // The parent renderer reparses the fence on every re-render, so `block` is
  // a fresh object each time; the coordinate signature keys the work instead.
  const pinSignature = block.places.map((place) => `${place.lat},${place.lng}`).join("|");

  useEffect(() => {
    if (!mapWidth) return;
    const pins = pinSignature
      .split("|")
      .filter(Boolean)
      .map((pair) => {
        const [lat, lng] = pair.split(",");
        return { lat: Number(lat), lng: Number(lng) };
      });
    const view = targetView ?? fitBounds(pins, mapWidth, MAP_HEIGHT);
    let cancelled = false;
    renderMapCard({
      centerLat: view.center.lat,
      centerLng: view.center.lng,
      zoom: view.zoom,
      width: mapWidth,
      height: MAP_HEIGHT,
    })
      .then((response) => {
        if (cancelled) return;
        // One commit: the new image and its projection replace the old pair
        // together, and the drag translation retires with them.
        setMapState({ url: response.dataUrl, center: view.center, zoom: view.zoom });
        setDragOffset({ dx: 0, dy: 0 });
      })
      .catch(() => {
        if (!cancelled) setMapFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mapWidth, pinSignature, targetView]);

  const zoomTo = (delta: number) => {
    if (!mapState) return;
    const zoom = Math.min(MAX_MAP_ZOOM, Math.max(MIN_MAP_ZOOM, mapState.zoom + delta));
    if (zoom === mapState.zoom) return;
    setTargetView({ center: mapState.center, zoom });
  };

  const attribution = block.attribution === "google" ? "Google" : "© OpenStreetMap contributors";
  const attributionUrl =
    block.attribution === "google"
      ? "https://www.google.com/maps"
      : "https://www.openstreetmap.org/copyright";

  return (
    <section ref={containerRef} className="chat-block" aria-label={block.title || t("Places")}>
      {block.title ? <h4 className="chat-block-title">{block.title}</h4> : null}
      {mapState && mapWidth ? (
        <div
          className="chat-block-map"
          style={{ height: MAP_HEIGHT }}
          data-dragging={dragRef.current?.moved || undefined}
          onPointerDown={(event) => {
            // Everything but touch: a touch drag must keep scrolling the
            // conversation, while mouse and pen can pan the map. An absent
            // button (synthetic events) counts as the primary one.
            if (event.pointerType === "touch" || (event.button ?? 0) !== 0) return;
            dragRef.current = { startX: event.clientX, startY: event.clientY, moved: false };
            // Optional call: absent in test DOMs, and losing capture only
            // means a drag that leaves the card stops following.
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag) return;
            const dx = event.clientX - drag.startX;
            const dy = event.clientY - drag.startY;
            if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            drag.moved = true;
            setDragOffset({ dx, dy });
          }}
          onPointerUp={(event) => {
            const drag = dragRef.current;
            dragRef.current = null;
            if (!drag?.moved || !mapState) return;
            const dx = event.clientX - drag.startX;
            const dy = event.clientY - drag.startY;
            // The translated image stays put; the settled render replaces it
            // and clears the offset in one commit (see the effect).
            setTargetView({
              center: panCenter(mapState.center, mapState.zoom, dx, dy),
              zoom: mapState.zoom,
            });
          }}
          onPointerCancel={() => {
            dragRef.current = null;
            setDragOffset({ dx: 0, dy: 0 });
          }}
        >
          <div
            className="chat-block-map-layer"
            style={{ transform: `translate(${dragOffset.dx}px, ${dragOffset.dy}px)` }}
          >
            <img src={mapState.url} alt="" aria-hidden draggable={false} />
            {block.places.map((place, index) => {
              const offset = pixelOffset(
                place,
                mapState.center,
                mapState.zoom,
                mapWidth,
                MAP_HEIGHT,
              );
              const visible =
                offset.left >= -PIN_MARGIN &&
                offset.left <= mapWidth + PIN_MARGIN &&
                offset.top >= -PIN_MARGIN &&
                offset.top <= MAP_HEIGHT + PIN_MARGIN;
              if (!visible) return null;
              return (
                <button
                  key={`${place.lat}:${place.lng}:${place.name}`}
                  type="button"
                  className="chat-block-pin"
                  data-hot={hot === index || undefined}
                  style={{ left: offset.left, top: offset.top }}
                  aria-label={t("Open {name} in Maps", { name: place.name })}
                  onMouseEnter={() => setHot(index)}
                  onMouseLeave={() => setHot((current) => (current === index ? null : current))}
                  onFocus={() => setHot(index)}
                  onBlur={() => setHot((current) => (current === index ? null : current))}
                  onClick={() => {
                    if (dragRef.current?.moved) return;
                    void openExternalUrl(mapsUrl(place));
                  }}
                >
                  <span>{index + 1}</span>
                </button>
              );
            })}
          </div>
          <div className="chat-block-map-zoom">
            <button type="button" aria-label={t("Zoom in")} onClick={() => zoomTo(1)}>
              <IconPlusMedium size={13} />
            </button>
            <button type="button" aria-label={t("Zoom out")} onClick={() => zoomTo(-1)}>
              <IconMinusMedium size={13} />
            </button>
          </div>
          <button
            type="button"
            className="chat-block-map-attribution"
            onClick={() => void openExternalUrl(attributionUrl)}
          >
            {attribution}
          </button>
        </div>
      ) : null}
      <ul className="chat-block-rows">
        {block.places.map((place, index) => (
          <li key={`${place.lat}:${place.lng}:${place.name}`}>
            <div
              className="chat-block-row chat-block-place-row"
              data-hot={hot === index || undefined}
            >
              <button
                type="button"
                className="chat-block-place-open"
                title={t("Open {name} in Maps", { name: place.name })}
                onMouseEnter={() => setHot(index)}
                onMouseLeave={() => setHot((current) => (current === index ? null : current))}
                onFocus={() => setHot(index)}
                onBlur={() => setHot((current) => (current === index ? null : current))}
                onClick={() => void openExternalUrl(mapsUrl(place))}
              >
                <PlaceThumb place={place} index={index} />
                <span className="chat-block-row-body">
                  <span className="chat-block-row-title">{place.name}</span>
                  <span className="chat-block-row-meta">{placeMeta(place)}</span>
                  {place.note ? <span className="chat-block-row-note">{place.note}</span> : null}
                </span>
              </button>
              {place.url ? (
                <button
                  type="button"
                  className="chat-block-place-site"
                  title={t("Open the website")}
                  aria-label={t("Open the website of {name}", { name: place.name })}
                  onClick={() => void openExternalUrl(place.url ?? "")}
                >
                  <IconGlobe size={15} />
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {!mapState && mapFailed ? (
        <p className="chat-block-footer-attribution">{t("Data: {attribution}", { attribution })}</p>
      ) : null}
    </section>
  );
}

/**
 * The row's leading visual: the place's photo when the provider gave one and
 * Rust can resolve it (Google key present), the numbered badge otherwise.
 * Failure is silent — the badge is a complete design, not an error state.
 */
function PlaceThumb({ place, index }: { place: ChatBlockPlace; index: number }) {
  const [photo, setPhoto] = useState<string | null>(null);
  const photoRef = place.photoRef;

  useEffect(() => {
    if (!photoRef) return;
    let cancelled = false;
    placesPhotoDataUrl(photoRef)
      .then((response) => {
        if (!cancelled) setPhoto(response.dataUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [photoRef]);

  if (photo) {
    return (
      <span className="chat-block-place-thumb" aria-hidden>
        <img src={photo} alt="" />
        <span className="chat-block-place-thumb-index">{index + 1}</span>
      </span>
    );
  }
  return (
    <span className="chat-block-pin-index" aria-hidden>
      {index + 1}
    </span>
  );
}

function mapsUrl(place: ChatBlockPlace): string {
  return `https://maps.apple.com/?ll=${place.lat},${place.lng}&q=${encodeURIComponent(place.name)}`;
}

function placeMeta(place: ChatBlockPlace): string {
  const parts: string[] = [];
  if (place.rating !== undefined) {
    const reviews = place.reviews !== undefined ? ` (${place.reviews})` : "";
    parts.push(`★ ${place.rating.toLocaleString(intlLocale())}${reviews}`);
  }
  if (place.category) parts.push(place.category);
  if (place.address) parts.push(place.address);
  return parts.join(" · ");
}
