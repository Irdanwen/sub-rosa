// A setting riding in the dock's bar: the model, the ratio, the length. The
// chip shows the value; pressing it chooses another. On the phone the choice
// opens in a sheet at the shell, on the desktop in a short menu under the
// chip, where the eye already is.

import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { forwardRef, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hapticSelection } from "../../../lib/haptics";
import { isMobilePlatform } from "../../../lib/mobile";
import { OptionSheet } from "../../mobile/OptionSheet";
import { sheetHost } from "../../mobile/sheet-host";
import { Popover } from "../../ui/Popover";

export const DockChip = forwardRef<
  HTMLButtonElement,
  {
    /** What the setting is, for a screen reader; the chip itself shows the value. */
    label: string;
    value: string;
    onOpen: () => void;
    expanded?: boolean;
  }
>(function DockChip({ label, value, onOpen, expanded }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className="stage-chip"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={`${label}, ${value}`}
      title={label}
      onClick={() => {
        hapticSelection();
        onOpen();
      }}
    >
      <span className="stage-chip-value">{value}</span>
      <IconChevronDownSmall size={14} aria-hidden />
    </button>
  );
});

/** A dock chip with a short list of values. */
export function DockSelectChip({
  label,
  value,
  options,
  onChange,
  format = (option) => option,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  format?: (option: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  return (
    <>
      <DockChip
        ref={anchor}
        label={label}
        value={format(value)}
        expanded={open}
        onOpen={() => setOpen((current) => !current)}
      />
      {open && isMobilePlatform()
        ? // Portaled: the dock's frosted glass is a containing block for
          // anything fixed inside it, and the sheet would open inside the card.
          createPortal(
            <OptionSheet
              title={label}
              options={options.map((option) => ({ value: option, label: format(option) }))}
              selected={value}
              onSelect={(next) => {
                onChange(next);
                close();
              }}
              onClose={close}
            />,
            sheetHost(),
          )
        : null}
      {!isMobilePlatform() ? (
        <Popover
          anchorRef={anchor}
          open={open}
          onClose={close}
          label={label}
          role="listbox"
          tone="stage"
          width={200}
          initialFocusSelector="[aria-selected='true']"
        >
          <ul className="stage-menu">
            {options.map((option) => (
              <li key={option}>
                <button
                  type="button"
                  role="option"
                  aria-selected={option === value}
                  className="stage-menu-item"
                  onClick={() => {
                    onChange(option);
                    close();
                  }}
                >
                  <span className="stage-menu-check" aria-hidden>
                    {option === value ? <IconCheckmark1Small size={16} /> : null}
                  </span>
                  {format(option)}
                </button>
              </li>
            ))}
          </ul>
        </Popover>
      ) : null}
    </>
  );
}
