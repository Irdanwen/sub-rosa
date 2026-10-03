// The frame before anything is made: the darkroom's light, turned down and
// slowed, with the rose in the middle. It holds the result's shape so the
// first render lands where the eye already is, and it says the frame is
// blank on purpose rather than showing whatever was made last time.

import { type CSSProperties, type ReactNode, useMemo } from "react";
import { darkroomSeed, darkroomVars } from "../../../lib/studio/darkroom";
import { BrandMark } from "../../brand/Marks";

export function IdleCanvas({
  seed,
  hint,
  action,
}: {
  /** Anything stable about the surface; the light is derived from it. */
  seed: string;
  /** One line under the rose: what goes here. */
  hint: ReactNode;
  /** An optional control at the frame's foot ("Last creation"). */
  action?: ReactNode;
}) {
  const light = useMemo(() => darkroomVars(darkroomSeed(seed)), [seed]);
  return (
    <div className="stage-idle" style={light as CSSProperties}>
      <div className="darkroom-field" aria-hidden>
        <span className="darkroom-lights">
          <span className="darkroom-light darkroom-light-a" />
          <span className="darkroom-light darkroom-light-b" />
          <span className="darkroom-light darkroom-light-c" />
        </span>
        <span className="darkroom-grain" />
      </div>
      <div className="stage-idle-center">
        <span className="stage-idle-mark">
          <BrandMark />
        </span>
        <p className="stage-idle-hint">{hint}</p>
      </div>
      {action ? <div className="stage-idle-action">{action}</div> : null}
    </div>
  );
}
