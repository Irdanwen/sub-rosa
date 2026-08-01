import type { Editor } from "@tiptap/react";
import { ReactRenderer } from "@tiptap/react";
import type { PluginKey } from "@tiptap/pm/state";
import type { ComponentType } from "react";

/**
 * The composer's suggestion popover, shared by every palette the editor
 * offers: `/` (commands, categories, skills) and `@` (files, folders, notes).
 *
 * Everything here is presentation and lifecycle — where the menu sits, when it
 * closes, which element owns the keyboard. What each palette *lists* is its
 * own business and arrives as `listComponent` + the suggestion's `items`.
 *
 * The menu is portaled to `document.body` rather than positioned inside the
 * composer: the composer box is clipped and the menu has to escape it. That
 * portal is also why the host carries {@link SUGGESTION_MENU_HOST_CLASS} — the
 * editor's Enter handler looks for it to know whether a palette is open and
 * therefore owns the key (see ComposerEditor).
 */

/** Marks an open palette. Present on every palette's host element: the editor
 * keys "is a palette open?" off it, so a palette that omitted it would submit
 * the message instead of committing the highlighted item. */
export const SUGGESTION_MENU_HOST_CLASS = "agent-category-menu-host";

/** Minimum a palette's list handle must expose: the popover forwards keys it
 * does not handle itself (Escape) to the list. */
export type SuggestionListHandle = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

/** What tiptap hands the renderer. `command` is typed loosely on purpose: the
 * suggestion plugin declares it against the mention node's attributes, while
 * each palette commits its own item shape, so the concrete type is restored
 * where the list component is rendered. */
type SuggestionRenderProps = {
  items: unknown[];
  command: (item: never) => void;
  editor: Editor;
  query: string;
  clientRect?: (() => DOMRect | null) | null;
};

export type SuggestionPopoverOptions<Item, Props> = {
  listComponent: ComponentType<Props>;
  /** The suggestion plugin's key. A click outside closes the menu *through*
   * the plugin (an `{exit: true}` meta), so its state clears with the popover;
   * tearing the host down alone would leave the plugin armed. */
  pluginKey: PluginKey;
  /** Extra class on the host, for palette-specific styling. The shared
   * {@link SUGGESTION_MENU_HOST_CLASS} is always applied. */
  hostClassName?: string;
  /** Lets a palette rebuild its list while open, for items that arrive after
   * the menu opened (skills finish loading). The event is dispatched on the
   * host; `itemsFor` recomputes from the live query. */
  refresh?: {
    eventName: string;
    itemsFor: (query: string) => Item[];
  };
};

/** Builds the `render` half of a tiptap suggestion. The returned object is
 * handed straight to `suggestion.render`. */
export function createSuggestionPopover<
  Item,
  Handle extends SuggestionListHandle,
  Props extends { items: Item[]; command: (item: Item) => void },
>(options: SuggestionPopoverOptions<Item, Props>) {
  return () => {
    let renderer: ReactRenderer<Handle, Props> | null = null;
    let host: HTMLDivElement | null = null;
    let latestProps: SuggestionRenderProps | null = null;
    let ownerDocument: Document | null = null;
    let ownerWindow: Window | null = null;

    function position(props: { clientRect?: (() => DOMRect | null) | null; editor: Editor }) {
      if (!host || !props.clientRect) return;
      const rect = props.clientRect();
      if (!rect) return;
      const viewport = props.editor.view.dom.ownerDocument.defaultView ?? window;
      const gap = 6;
      const pad = 8;
      const composerBox = props.editor.view.dom.closest<HTMLElement>(".agent-composer-box");
      const composerRect = composerBox?.getBoundingClientRect();
      const width = Math.min(
        composerRect?.width ?? host.getBoundingClientRect().width,
        viewport.innerWidth - pad * 2,
      );
      host.style.setProperty("--agent-category-menu-width", `${width}px`);
      const maxLeft = viewport.innerWidth - width - pad;
      const left = Math.min(Math.max(composerRect?.left ?? rect.left, pad), Math.max(pad, maxLeft));
      const anchorRect = composerRect ?? rect;
      const belowTop = anchorRect.bottom + gap;
      const belowSpace = viewport.innerHeight - belowTop - pad;
      const aboveSpace = anchorRect.top - gap - pad;
      const hostRect = host.getBoundingClientRect();
      const hasMeasuredHeight = hostRect.height > 0;
      const fitsBelow = hasMeasuredHeight && belowSpace >= hostRect.height;
      const fitsAbove = hasMeasuredHeight && aboveSpace >= hostRect.height;
      const placeBelow = fitsBelow || (!fitsAbove && belowSpace >= aboveSpace);
      const maxHeight = Math.max(0, Math.min(placeBelow ? belowSpace : aboveSpace, 280));

      host.style.setProperty("--agent-category-menu-max-height", `${maxHeight}px`);
      if (placeBelow) {
        host.style.bottom = "";
        host.style.top = `${Math.max(belowTop, pad)}px`;
      } else {
        // Anchor the menu's composer-facing edge instead of deriving its
        // top from a height that can be stale while async items render.
        // The portal then grows upward and remains inside short webviews.
        host.style.top = "";
        host.style.bottom = `${Math.max(viewport.innerHeight - anchorRect.top + gap, pad)}px`;
      }
      host.style.left = `${left}px`;
    }

    function positionLatest() {
      if (latestProps) position(latestProps);
    }

    function refreshItems() {
      if (!renderer || !latestProps || !options.refresh) return;
      renderer.updateProps({
        items: options.refresh.itemsFor(latestProps.query),
        command: latestProps.command,
      } as unknown as Partial<Props>);
      position(latestProps);
    }

    function dismissFromPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node) || host?.contains(target)) return;
      const view = latestProps?.editor.view;
      if (!view) return;
      // The plugin's own exit path: it clears the suggestion state and calls
      // onExit, which tears the popover down.
      view.dispatch(view.state.tr.setMeta(options.pluginKey, { exit: true }));
    }

    function cleanupPopover() {
      renderer?.destroy();
      if (options.refresh) {
        host?.removeEventListener(options.refresh.eventName, refreshItems);
      }
      ownerDocument?.removeEventListener("pointerdown", dismissFromPointerDown, true);
      ownerWindow?.removeEventListener("resize", positionLatest);
      ownerWindow?.visualViewport?.removeEventListener("resize", positionLatest);
      host?.remove();
      renderer = null;
      host = null;
      latestProps = null;
      ownerDocument = null;
      ownerWindow = null;
    }

    return {
      onStart(props: SuggestionRenderProps) {
        latestProps = props;
        renderer = new ReactRenderer<Handle, Props>(options.listComponent, {
          props: { items: props.items, command: props.command } as unknown as Props,
          editor: props.editor,
        });
        host = document.createElement("div");
        host.className = options.hostClassName
          ? `${SUGGESTION_MENU_HOST_CLASS} ${options.hostClassName}`
          : SUGGESTION_MENU_HOST_CLASS;
        if (options.refresh) host.addEventListener(options.refresh.eventName, refreshItems);
        host.appendChild(renderer.element);
        document.body.appendChild(host);
        ownerDocument = props.editor.view.dom.ownerDocument;
        ownerWindow = ownerDocument.defaultView;
        ownerDocument.addEventListener("pointerdown", dismissFromPointerDown, true);
        ownerWindow?.addEventListener("resize", positionLatest);
        ownerWindow?.visualViewport?.addEventListener("resize", positionLatest);
        position(props);
      },
      onUpdate(props: SuggestionRenderProps) {
        latestProps = props;
        renderer?.updateProps({
          items: props.items,
          command: props.command,
        } as unknown as Partial<Props>);
        position(props);
      },
      onKeyDown(props: { event: KeyboardEvent }) {
        if (props.event.key === "Escape") {
          cleanupPopover();
          return true;
        }
        return renderer?.ref?.onKeyDown(props.event) ?? false;
      },
      onExit() {
        cleanupPopover();
      },
    };
  };
}
