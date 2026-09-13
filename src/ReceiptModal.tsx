import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { siprec, ReceiptVerification } from './api';
import { purposeLabel } from './purposes';

// Views one signed receipt, in place.
//
// It used to open portal_receipt_verify.php in a new tab. Inside Horizon that
// is a worse experience than it sounds: the receipt is a detail of the row you
// were reading, and a tab switch loses the page you were on, the scope you had
// selected, and — on a federated app — costs a full remote reload to come back
// to. So the same content is rendered here instead.
//
// Presented the same way as the page that endpoint still serves (and the same
// way siprec-viewer's ReceiptModal shows one): verification result first, then
// what was agreed in labelled fields, then the signed bytes for anyone who
// wants to check it themselves. A receipt is evidence a person may have to
// read and act on, so it must not look different depending on which console it
// was opened from.
//
// "Open as a page" is deliberately kept: the server-rendered page is the
// printable, linkable, shareable artefact, and a modal is none of those.

interface Props {
  receiptId: string;
  dark: boolean;
  onClose: () => void;
}

export const ReceiptModal: React.FC<Props> = ({ receiptId, dark, onClose }) => {
  const [verified, setVerified] = useState<ReceiptVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showBytes, setShowBytes] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    siprec.verifyReceipt(receiptId)
      .then(v => { if (!cancelled) setVerified(v); })
      .catch(e => { if (!cancelled) setError(e?.message || 'Failed to load the receipt.'); });
    return () => { cancelled = true; };
  }, [receiptId]);

  // Escape closes, and focus moves into the panel so a keyboard user is not
  // left tabbing through the page behind the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
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

  // Every control carries explicit border/background/colour/cursor. Horizon's
  // stylesheet flattens bare <button> and <a>, which previously made the
  // receipt controls read as static text — they were rendering all along.
  const surface = dark ? '#1c1f2b' : '#ffffff';
  const ink = dark ? '#e8e8ea' : '#1E2130';
  const hairline = '1px solid rgba(128,128,128,0.28)';

  const button: React.CSSProperties = {
    appearance: 'none',
    border: hairline,
    borderRadius: 6,
    background: dark ? '#262a38' : '#f5f5f7',
    color: ink,
    cursor: 'pointer',
    fontSize: 13,
    padding: '6px 12px',
    textDecoration: 'none',
    display: 'inline-block',
    lineHeight: 1.4,
  };
  const primary: React.CSSProperties = {
    ...button,
    background: '#C8862F',
    borderColor: '#C8862F',
    color: '#ffffff',
    fontWeight: 600,
  };
  const card: React.CSSProperties = {
    border: hairline,
    borderRadius: 8,
    padding: '12px 14px',
    marginTop: 12,
  };
  const mono: React.CSSProperties = {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    wordBreak: 'break-all',
  };
  const dt: React.CSSProperties = { fontWeight: 600, opacity: 0.7, fontSize: 12 };
  const dd: React.CSSProperties = { margin: '2px 0 10px 0', fontSize: 13 };

  const r: Record<string, any> = verified?.receipt ?? {};
  const subject = r.data_subject ?? {};
  const applies = r.applies_to ?? {};
  const agreement = r.agreement ?? {};
  const updated = applies.existing_conversations_updated;

  const download = () => {
    if (!verified) {
      return;
    }
    const bundle = {
      receipt: verified.receipt,
      signature_b64: verified.signature_b64,
      public_key_b64: verified.public_key_b64,
      algorithm: verified.algorithm || 'Ed25519',
      verify: 'Ed25519-verify(signature, canonical receipt JSON bytes, public_key)',
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${receiptId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Rendered into <body> rather than in place. `position: fixed` is resolved
  // against the nearest ancestor carrying a transform/filter/perspective, not
  // the viewport — so a single transformed wrapper anywhere in Horizon's
  // layout would pin this overlay inside a table cell. A portal makes the
  // result independent of whatever the host wraps the page in, which given how
  // much of Horizon's styling has already leaked into these controls is the
  // assumption worth not making.
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
        aria-label="Consent receipt"
        onClick={e => e.stopPropagation()}
        style={{
          background: surface, color: ink,
          border: hairline, borderRadius: 10,
          boxShadow: '0 18px 48px rgba(0,0,0,0.35)',
          width: 'min(720px, 100%)', padding: 20,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          outline: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 17 }}>Consent receipt</h3>
            <div style={{ ...mono, fontSize: 11, opacity: 0.65, marginTop: 3 }}>{receiptId}</div>
          </div>
          <button type="button" onClick={onClose} style={button} aria-label="Close">Close</button>
        </div>

        {error && (
          <div style={{ ...card, borderColor: '#A63D40', color: '#A63D40' }}>{error}</div>
        )}
        {!verified && !error && (
          <div style={{ marginTop: 14, fontSize: 13, opacity: 0.7 }}>Loading and verifying…</div>
        )}

        {verified && (
          <>
            <div style={{
              ...card,
              fontWeight: 600, fontSize: 13,
              color: verified.signature_valid ? '#2E7D4F' : '#A63D40',
              borderColor: verified.signature_valid ? '#2E7D4F' : '#A63D40',
            }}>
              {verified.signature_valid
                ? '✓ Signature valid — this receipt is authentic and unaltered'
                : '✗ Signature INVALID — do not rely on this receipt'}
            </div>

            <div style={card}>
              <h4 style={{ margin: '0 0 10px 0', fontSize: 14 }}>What was agreed</h4>

              <div style={dt}>Data subject</div>
              <div style={dd}>
                {subject.name || '—'}
                {/* The person, by user ID — not whichever handset they used. */}
                {subject.uid && <div style={{ ...mono, fontSize: 11, opacity: 0.7 }}>{subject.uid}</div>}
              </div>

              <div style={dt}>Decision</div>
              <div style={dd}>{r.action || '—'}</div>

              <div style={dt}>Purposes</div>
              <div style={dd}>
                {Array.isArray(r.purposes) && r.purposes.length > 0
                  ? r.purposes.map((p: string) => purposeLabel(p)).join(' · ')
                  : <span style={{ opacity: 0.7 }}>none — consent withdrawn</span>}
              </div>

              <div style={dt}>Applies to</div>
              <div style={dd}>
                {applies.future_conversations
                  ? 'Future conversations'
                  : 'Future conversations not included'}
                {typeof updated === 'number' &&
                  ` · ${updated} existing conversation${updated === 1 ? '' : 's'} updated`}
              </div>

              <div style={dt}>Signed at</div>
              <div style={{ ...dd, ...mono, fontSize: 12 }}>{r.signed_at || '—'}</div>

              {r.asserted_by && (
                <>
                  <div style={dt}>Asserted by</div>
                  <div style={dd}>
                    {r.asserted_by === 'data_subject' ? 'the data subject' : r.asserted_by}
                    {r.asserted_via && <span style={{ opacity: 0.7 }}> (via {r.asserted_via})</span>}
                  </div>
                </>
              )}

              <div style={dt}>Agreement</div>
              <div style={{ ...dd, marginBottom: 0 }}>
                version {agreement.version || '—'}
                {agreement.sha256 && (
                  <div style={{ ...mono, fontSize: 11, opacity: 0.7 }}>sha256 {agreement.sha256}</div>
                )}
              </div>
            </div>

            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                <h4 style={{ margin: 0, fontSize: 14 }}>Verify this yourself</h4>
                <span style={{ fontSize: 11, opacity: 0.65 }}>{verified.algorithm}</span>
              </div>
              <p style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
                The signed bytes, signature and public key are all you need — checking a
                receipt does not require this platform&rsquo;s cooperation, and nobody
                should have to take its word for it.
              </p>

              <div style={dt}>Signature</div>
              <div style={{ ...dd, ...mono, fontSize: 11 }}>{verified.signature_b64}</div>
              <div style={dt}>Public key</div>
              <div style={{ ...dd, ...mono, fontSize: 11 }}>{verified.public_key_b64}</div>

              {/* Collapsed by default: the canonical bytes are the least readable
                  and least often wanted part, but they are what the signature is
                  over, so they must be reachable. Shown byte-exact — never
                  re-encoded, or the signature would no longer check out. */}
              <button type="button" style={button} onClick={() => setShowBytes(v => !v)}>
                {showBytes ? 'Hide signed bytes' : 'Show signed bytes'}
              </button>
              {showBytes && (
                <pre style={{
                  ...mono, fontSize: 11, marginTop: 8, marginBottom: 0,
                  maxHeight: 220, overflow: 'auto',
                  background: dark ? '#12141c' : '#f7f7f9',
                  border: hairline, borderRadius: 6, padding: 10,
                  whiteSpace: 'pre-wrap',
                }}>
                  {verified.receipt_json}
                </pre>
              )}
            </div>

            <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button type="button" style={primary} onClick={download}>
                Download signed receipt
              </button>
              {/* The printable, linkable artefact — a modal is neither. */}
              <a href={siprec.receiptUrl(receiptId)} target="_blank" rel="noreferrer" style={button}>
                Open as a page
              </a>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
};
