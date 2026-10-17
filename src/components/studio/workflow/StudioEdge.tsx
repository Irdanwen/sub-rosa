// The canvas edge: a bezier wire plus the badge that says which position it
// holds on a port that takes several connections.

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useStore,
  type EdgeProps,
} from "@xyflow/react";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { t } from "../../../lib/i18n";

/** How far out the canvas can zoom before the order badges become noise.
 * A fit-to-view of a production-sized graph sits around 0.6-0.8, and the
 * badges must be there in that default state — they only vanish once the
 * nodes themselves have shrunk past reading. */
const EDGE_ORDER_MIN_ZOOM = 0.45;

/** How far right of a source handle its order badge sits, and how far apart
 * two badges leaving the same node stack. */
const EDGE_ORDER_GAP = 18;

/** What an edge carries beyond its endpoints: its 1-based position on the
 * port it lands on, where to stack the badge when one node feeds several
 * ordered connections, and whether the list is pointing at it right now. */
export interface StudioEdgeData extends Record<string, unknown> {
  order?: number;
  /** 0-based rank among the ordered edges leaving this same source. */
  sourceRank?: number;
  highlight?: boolean;
  /** What the connection carries, which colours the wire. */
  kind?: string;
  /** Remove this connection (the button on a selected wire). */
  onDelete?: (edgeId: string) => void;
}

/**
 * The default bezier edge plus a connection-order badge.
 *
 * The badge sits at the **source** end, just outside the node it belongs to.
 * Pinned at the port end it answered the wrong question: a video node's five
 * reference badges lined up in front of one "References" label, saying which
 * position each wire held but never which photo was in it. On the source, "1"
 * is physically on the asset that is first.
 *
 * Placed from the handle rather than sampled off the curve on purpose: the
 * control points are the layout library's business and change with it, while
 * the handle is where the wire visibly leaves the node.
 */
export function StudioEdge(props: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  const zoom = useStore((state) => state.transform[2]);
  const data = props.data as StudioEdgeData | undefined;
  const order = data?.order;
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={
          data?.kind && data.kind !== "none" && data.kind !== "any"
            ? { ...props.style, stroke: `var(--kind-${data.kind})` }
            : props.style
        }
        markerEnd={props.markerEnd}
        className={data?.highlight ? "studio-edge-lit" : undefined}
      />
      {props.selected && data?.onDelete ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="studio-edge-delete nodrag nopan"
            aria-label={t("Remove this connection")}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={() => data.onDelete?.(props.id)}
          >
            <IconCrossSmall size={12} />
          </button>
        </EdgeLabelRenderer>
      ) : null}
      {order !== undefined && zoom >= EDGE_ORDER_MIN_ZOOM ? (
        <EdgeLabelRenderer>
          <span
            className="studio-edge-order"
            data-lit={data?.highlight ? "" : undefined}
            style={{
              // One node can feed several ordered connections, and they all
              // leave the same handle: stack them so two badges never land on
              // the same pixel.
              transform: `translate(-50%, -50%) translate(${
                props.sourceX + EDGE_ORDER_GAP
              }px, ${props.sourceY + (data?.sourceRank ?? 0) * EDGE_ORDER_GAP}px)`,
            }}
          >
            {order}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const EDGE_TYPES = { studio: StudioEdge };
