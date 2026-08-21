import { IconGlobe } from "central-icons/IconGlobe";
import { useEffect, useRef, useState } from "react";
import type { ChatBlockPlace, PlacesChatBlock } from "../../lib/chat-blocks";
import { fitBounds, pixelOffset } from "../../lib/map-projection";
import { openExternalUrl, renderMapCard } from "../../lib/tauri";

/** Logical map banner height; width follows the card. */
const MAP_HEIGHT = 200;
/** Pins closer than this to the edge are drawn anyway; further out, hidden. */
const PIN_MARGIN = 10;

/**
 * The places chat block: a static map banner (rendered by Rust from OSM
 * tiles), DOM pins projected over it, and the list of places. Hovering a row
 * lights its pin and vice versa. Without a map (render failed, browser
 * preview without a bridge), the list stands alone — the card never blocks
 * on the banner.
 */
export function PlacesCard({ block }: { block: PlacesChatBlock }) {
  const containerRef = useRef<HTMLElement>(null);
  const [mapWidth, setMapWidth] = useState<number | null>(null);
  const [mapUrl, setMapUrl] = useState<string | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  const [hot, setHot] = useState<number | null>(null);

  useEffect(() => {
    const width = containerRef.current?.clientWidth;
    // Rounding keeps one render request per card width family and makes the
    // tile cache actually hit across cards.
    setMapWidth(width ? Math.max(240, Math.round(width / 20) * 20) : 480);
  }, []);

  // Deterministic from width + places, so recomputing per render is free and
  // the effect below can derive its own copy without a dependency dance.
  const fit = mapWidth ? fitBounds(block.places, mapWidth, MAP_HEIGHT) : null;

  // The parent renderer reparses the fence on every re-render, so `block` is
  // a fresh object each time; keying the effect on the coordinates keeps one
  // render request per actual map, not one per parent render.
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
    const target = fitBounds(pins, mapWidth, MAP_HEIGHT);
    let cancelled = false;
    renderMapCard({
      centerLat: target.center.lat,
      centerLng: target.center.lng,
      zoom: target.zoom,
      width: mapWidth,
      height: MAP_HEIGHT,
    })
      .then((response) => {
        if (!cancelled) setMapUrl(response.dataUrl);
      })
      .catch(() => {
        if (!cancelled) setMapFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mapWidth, pinSignature]);

  const attribution = block.attribution === "google" ? "Google" : "© OpenStreetMap contributors";
  const attributionUrl =
    block.attribution === "google"
      ? "https://www.google.com/maps"
      : "https://www.openstreetmap.org/copyright";

  return (
    <section ref={containerRef} className="chat-block" aria-label={block.title || "Places"}>
      {block.title ? <h4 className="chat-block-title">{block.title}</h4> : null}
      {mapUrl && fit && mapWidth ? (
        <div className="chat-block-map" style={{ height: MAP_HEIGHT }}>
          <img src={mapUrl} alt="" aria-hidden />
          {block.places.map((place, index) => {
            const offset = pixelOffset(place, fit.center, fit.zoom, mapWidth, MAP_HEIGHT);
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
                aria-label={`Open ${place.name} in Maps`}
                onMouseEnter={() => setHot(index)}
                onMouseLeave={() => setHot((current) => (current === index ? null : current))}
                onFocus={() => setHot(index)}
                onBlur={() => setHot((current) => (current === index ? null : current))}
                onClick={() => void openExternalUrl(mapsUrl(place))}
              >
                <span>{index + 1}</span>
              </button>
            );
          })}
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
                title={`Open ${place.name} in Maps`}
                onMouseEnter={() => setHot(index)}
                onMouseLeave={() => setHot((current) => (current === index ? null : current))}
                onFocus={() => setHot(index)}
                onBlur={() => setHot((current) => (current === index ? null : current))}
                onClick={() => void openExternalUrl(mapsUrl(place))}
              >
                <span className="chat-block-pin-index" aria-hidden>
                  {index + 1}
                </span>
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
                  title="Open the website"
                  aria-label={`Open the website of ${place.name}`}
                  onClick={() => void openExternalUrl(place.url ?? "")}
                >
                  <IconGlobe size={15} />
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {!mapUrl && (mapFailed || !fit) ? (
        <p className="chat-block-footer-attribution">Data: {attribution}</p>
      ) : null}
    </section>
  );
}

function mapsUrl(place: ChatBlockPlace): string {
  return `https://maps.apple.com/?ll=${place.lat},${place.lng}&q=${encodeURIComponent(place.name)}`;
}

function placeMeta(place: ChatBlockPlace): string {
  const parts: string[] = [];
  if (place.rating !== undefined) {
    const reviews = place.reviews !== undefined ? ` (${place.reviews})` : "";
    parts.push(`★ ${place.rating.toLocaleString()}${reviews}`);
  }
  if (place.category) parts.push(place.category);
  if (place.address) parts.push(place.address);
  return parts.join(" · ");
}
