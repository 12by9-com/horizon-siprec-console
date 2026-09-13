import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { siprec, VconDocument } from './api';
import { HorizonProps } from './horizon';

// The stored vCon document for one recording, read in place.
//
// Same idea as the console's View popup, and deliberately the same shape of
// answer: the document as JSON, with its bulky inline bodies cut to an
// identifiable preview. A recorded call carries its audio inline as base64 —
// the largest here was 7.7 MB, of which 7.68 M characters were one body — so
// showing it whole would mean pushing megabytes into an embedded app to render
// as text, and the reader would scroll past a wall of base64 to reach anything
// legible.
//
// The console keeps a "show full document" toggle beside its popup for anyone
// doing forensics. This one does not: inside Horizon the full document has no
// use that the console does not serve better, and the abbreviation is the
// reason the popup is usable at all.

interface Props {
  host: Partial<HorizonProps>;
  uuid: string;
  dark: boolean;
  onClose: () => void;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export const VconModal: React.FC<Props> = ({ host, uuid, dark, onClose }) => {
  const [doc, setDoc] = useState<VconDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    siprec.vcon(host, uuid)
      .then(d => { if (!cancelled) setDoc(d); })
      .catch(e => { if (!cancelled) setError(e?.message || 'Failed to load the vCon document.'); });
    return () => { cancelled = true; };
  }, [host, uuid]);

  // Escape closes, and focus moves into the panel so a keyboard user is not
  // left tabbing through the page behind the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    // Horizon's own page keeps scrolling behind a fixed overlay otherwise,
    // which reads as the modal being unresponsive.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const surface = dark ? '#1c1f2b' : '#ffffff';
  const ink = dark ? '#e8e8ea' : '#1E2130';
  const hairline = '1px solid rgba(128,128,128,0.28)';

  // Explicit chrome: Horizon's stylesheet flattens a bare <button> into what
  // reads as static text.
  const button: React.CSSProperties = {
    appearance: 'none',
    border: hairline,
    borderRadius: 6,
    background: dark ? '#262a38' : '#f5f5f7',
    color: ink,
    cursor: 'pointer',
    fontSize: 13,
    padding: '6px 12px',
    lineHeight: 1.4,
  };

  // How many bodies were shortened, and by how much — stated rather than left
  // for the reader to infer from a stray ellipsis in the JSON.
  const truncated: { section: string; index: number; kept: number; total: number }[] = [];
  for (const section of ['dialog', 'attachments']) {
    const entries = (doc?.document?.[section] ?? []) as any[];
    if (!Array.isArray(entries)) continue;
    entries.forEach((e, i) => {
      if (e && typeof e === 'object' && e.body_truncated) {
        truncated.push({
          section,
          index: i,
          kept: typeof e.body === 'string' ? e.body.length : 0,
          total: Number(e.body_total_chars) || 0,
        });
      }
    });
  }

  // A portal, because the page renders this from inside a table cell and the
  // surrounding layout would otherwise pin a "fixed" overlay inside it.
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 2147483000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '5vh 16px', overflowY: 'auto',
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="vCon document"
        onClick={e => e.stopPropagation()}
        style={{
          background: surface, color: ink,
          border: hairline, borderRadius: 10,
          boxShadow: '0 18px 48px rgba(0,0,0,0.35)',
          width: 'min(860px, 100%)', padding: 20,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          outline: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 17 }}>vCon document</h3>
            <div style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 11, opacity: 0.65, marginTop: 3, wordBreak: 'break-all',
            }}>
              {doc?.filename ?? uuid}
            </div>
          </div>
          <button type="button" onClick={onClose} style={button}>Close</button>
        </div>

        {doc && (
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 10 }}>
            Stored document {formatBytes(doc.size_bytes)} — inline media abbreviated for size.
            {truncated.length > 0 && (
              <ul style={{ margin: '6px 0 0 0', paddingLeft: 18 }}>
                {truncated.map(t => (
                  <li key={`${t.section}-${t.index}`}>
                    <code>{t.section}[{t.index}]</code> body shortened to {t.kept.toLocaleString()} of{' '}
                    {t.total.toLocaleString()} characters
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error && <div style={{ color: '#A63D40', marginTop: 12 }}>{error}</div>}
        {!doc && !error && <div style={{ marginTop: 12, opacity: 0.7 }}>Loading vCon document…</div>}

        {doc && (
          <pre style={{
            marginTop: 12, marginBottom: 0,
            background: dark ? '#12141c' : '#f7f7f9',
            border: hairline, borderRadius: 8,
            padding: 12,
            maxHeight: '60vh', overflow: 'auto',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 12, lineHeight: 1.45,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {JSON.stringify(doc.document, null, 2)}
          </pre>
        )}
      </div>
    </div>,
    document.body,
  );
};
