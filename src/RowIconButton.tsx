import React from 'react';

// One icon button on a row of a table this app does not own.
//
// `context.ui` carries Horizon's pre-themed IconButton, Icon and Tooltip, so a
// button built from them matches the native row actions beside it and follows
// the colour-scheme toggle without this app shipping MUI.
//
// The fallback is not decoration: the host builds that surface from a lazily
// filled slot, so an extension has to be able to render before it exists — and
// a bare <button> is flattened into what reads as static text by Horizon's
// stylesheet, hence the explicit chrome. `glyph` is what stands in for the
// iconify icon there; it has no access to the host's icon font, so each caller
// names a character that reads as the same thing.
//
// Lives in its own module because it is now drawn on two different host pages
// (Call Logs rows and Users rows) and the fallback chrome is the part that
// took the longest to get right — two copies of it would drift.
export const RowIconButton: React.FC<{
  ui?: any;
  icon: string;
  glyph: string;
  label: string;
  dark: boolean;
  busy?: boolean;
  onClick: () => void;
}> = ({ ui, icon, glyph, label, dark, busy, onClick }) => {
  if (ui?.IconButton) {
    const button = (
      <ui.IconButton
        icon={icon}
        iconSize={18}
        size="small"
        aria-label={label}
        disabled={busy}
        onClick={onClick}
      />
    );
    return ui.Tooltip ? <ui.Tooltip title={label} arrow>{button}</ui.Tooltip> : button;
  }
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={busy}
      onClick={onClick}
      style={{
        appearance: 'none', cursor: busy ? 'default' : 'pointer',
        border: `1px solid ${dark ? '#5a5c66' : '#bcbfc7'}`,
        background: dark ? '#2a2b31' : '#ffffff',
        color: dark ? '#e8e8ea' : '#1E2130',
        borderRadius: 6, fontSize: 12, lineHeight: 1.2, padding: '4px 7px',
        opacity: busy ? 0.5 : 1,
      }}
    >
      {glyph}
    </button>
  );
};
