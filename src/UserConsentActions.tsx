import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ConsentParty, ConsentRequest, PendingConsentRequest, siprec } from './api';
import { HorizonExtensionProps } from './horizon';
import { hostProps } from './host';
import { PROOF_LABELS, PURPOSE_DESCRIPTIONS, PURPOSE_LABELS } from './purposes';
import { ReceiptModal } from './ReceiptModal';
import { RowIconButton } from './RowIconButton';
import { forgetUserConsent, useUserConsent } from './userConsent';

// A consent button on the rows of Horizon's OWN Users table.
//
// Registered into the host's `table-row-actions` zone, which its shared
// DataTable renders at the end of every row's action column — so this appears
// beside Horizon's native Masquerade / Edit / Delete actions, on a page this
// app does not own and did not build.
//
// The bridge between the two systems is the user id. A NetSapiens seat is
// `user@domain`, and that is exactly what the recorder stores as
// party_consent.party_uid, derived from the SIP AOR it saw on the call. So a
// row of Horizon's Users grid names a person this platform may already hold a
// consent record for — keyed on the PERSON, never on a handset: someone who
// answers on a desk phone and a softphone has one consent decision covering
// both.
//
// It never CHANGES consent, deliberately. The popup shows what is recorded and
// lets the receipt behind it be read and re-verified; changing a decision stays
// on the Consent page, which is the one surface that shows the agreement,
// issues a receipt and rewrites the person's conversations. A Users page is
// where bulk administration happens, and "revoke recording consent, and rewrite
// every conversation this person appears in" does not belong one mis-click from
// the delete button beside it.
//
// The one thing it may write is a REQUEST. A seat only acquires a consent
// record once it has been on a recorded conversation, so most rows have none —
// and the answer to that is not to let an administrator invent one. It is to
// ask the person: the popup mints a portal invite, they open the link and
// decide, and the decision lands as self-asserted rather than as something
// decided on their behalf. An administrator asking is not an administrator
// answering.
//
// Nothing here decides WHO has a record, or who may be asked: the platform
// answers both under the caller's own role, so a row outside the caller's
// consent scope simply has no button.

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

// How the decision came to be recorded, in the words the Consent page uses.
// The same three states, so the two surfaces cannot describe one person's
// record differently.
function sourceLabel(source: string | null): string {
  switch (source) {
    case 'party': return 'self-asserted by the data subject';
    case 'console': return 'set by an administrator';
    default: return 'domain default';
  }
}

// The candidate user ids for one row of the Users grid.
//
// `user` is the NetSapiens account name and `extension` is the number. On an
// ordinary seat they are the same string and this collapses to one id — but
// they are allowed to differ, and the AOR the recorder saw could have been
// built from either, so both are offered and the platform is asked which it
// knows. The domain comes from the row itself: a Reseller drilling into a
// customer's domain gets rows that are not in their own.
//
// EXTENSION FIRST, and the order matters for exactly one case. When a record
// exists, whichever spelling holds it wins and the order is irrelevant. When
// none does, this order decides which uid a consent REQUEST is filed under —
// and it must be the one the recorder will later create the record under,
// which is built from the SIP address, i.e. the extension. Filing under the
// account name would leave the invite and the eventual record describing two
// different ids for one person.
export function candidateUidsFor(
  row: Record<string, unknown> | null,
  fallbackDomain?: string | null,
): string[] {
  if (!row) return [];
  const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number'
    ? String(v).trim() : '');
  const domain = text(row['domain']) || (fallbackDomain ?? '').trim();
  if (!domain || domain === 'unknown.com') return [];

  const uids: string[] = [];
  for (const field of ['extension', 'user']) {
    const local = text(row[field]);
    if (!local) continue;
    const uid = `${local}@${domain}`;
    if (!uids.includes(uid)) uids.push(uid);
  }
  return uids;
}

// Asking a person for their consent, from the row that names them.
//
// Mints a portal invite and shows the link. Delivery is out of band and always
// has been — the platform emails nobody — so the operator sends it the way they
// already reach that person. The link is shown in a field rather than only
// behind a Copy button, because a clipboard write can fail silently and a
// consent request that was never actually sent is the worst possible failure
// here.
//
// A live request is never duplicated: the platform hands back the one already
// out, which is why "Show the link again" and "Send request" are the same call.
const RequestConsent: React.FC<{
  uid: string;
  displayName: string | null;
  pending: PendingConsentRequest | null;
  defaultPurposes: string[];
  allPurposes: string[];
  dark: boolean;
  onChanged: () => void;
  styles: {
    button: React.CSSProperties; primary: React.CSSProperties;
    card: React.CSSProperties; mono: React.CSSProperties;
    dt: React.CSSProperties; dd: React.CSSProperties;
  };
}> = ({ uid, displayName, pending, defaultPurposes, allPurposes, dark,
        onChanged, styles }) => {
  const { button, primary, card, mono, dt, dd } = styles;
  // Seeded from the domain's standing policy rather than from nothing: that is
  // the position the operator has already taken for this customer, and an
  // invite offering more than it asks for more than their own policy says they
  // need.
  const [selected, setSelected] = useState<Set<string>>(new Set(defaultPurposes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConsentRequest | null>(null);
  const [copied, setCopied] = useState(false);
  // The row's answer is refreshed only when the popup closes (see onChanged in
  // UserConsentButton — refreshing sooner unmounts this panel and takes the
  // link with it), so a cancel has to be reflected here rather than waited for.
  const [cancelled, setCancelled] = useState(false);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await siprec.requestConsent(hostProps, {
        party_uid: uid,
        party_name: displayName || undefined,
        purposes: Array.from(selected),
      });
      setResult(res);
      onChanged();
    } catch (e: any) {
      setError(e?.message || 'Could not create the consent request');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: number) => {
    if (!window.confirm(
      'Cancel this consent request? The link stops working immediately.')) return;
    setBusy(true);
    setError(null);
    try {
      await siprec.cancelConsentRequest(hostProps, id);
      setResult(null);
      setCancelled(true);
      onChanged();
    } catch (e: any) {
      setError(e?.message || 'Could not cancel the request');
    } finally {
      setBusy(false);
    }
  };

  // Best effort. The field below is the reliable path, so a clipboard that
  // refuses is not an error worth showing.
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); },
      () => undefined,
    );
  };

  const link = result ? (result.portal_url ?? result.portal_path) : null;
  // A cancelled request is gone as far as this panel is concerned, which puts
  // the offer form back rather than leaving the reader looking at a link that
  // no longer works.
  const live = cancelled ? null : pending;
  const openId = result?.id ?? live?.id ?? null;

  return (
    <div style={card}>
      <h4 style={{ margin: '0 0 8px 0', fontSize: 14 }}>
        {live || result ? 'Consent request' : 'Ask for consent'}
      </h4>

      {live && !result && (
        <>
          <p style={{ fontSize: 13, opacity: 0.85, margin: '0 0 10px' }}>
            A request is already out, offering{' '}
            <b>{live.offered_purposes.map(p => PURPOSE_LABELS[p] || p).join(', ')
                 || 'nothing'}</b>.
          </p>
          <div style={dt}>Requested</div>
          <div style={dd}>
            {formatWhen(live.created_at)}
            {live.created_by && (
              <span style={{ opacity: 0.7 }}> · by {live.created_by}</span>
            )}
          </div>
          <div style={dt}>Link expires</div>
          <div style={{ ...dd, marginBottom: 12 }}>{formatWhen(live.expires_at)}</div>
        </>
      )}

      {!live && !result && (
        <>
          <p style={{ fontSize: 13, opacity: 0.85, margin: '0 0 10px' }}>
            This sends {displayName || 'them'} a link to decide for themselves.
            Nothing is recorded until they answer, and what they choose is
            stored as their own decision with a signed receipt — not as one made
            on their behalf.
          </p>
          <div style={{ ...dt, marginBottom: 4 }}>Purposes to offer</div>
          {allPurposes.map(p => (
            <label key={p} style={{
              display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0',
              fontSize: 13, cursor: busy ? 'default' : 'pointer',
            }}>
              <input
                type="checkbox"
                disabled={busy}
                checked={selected.has(p)}
                onChange={() => setSelected(prev => {
                  const next = new Set(prev);
                  if (next.has(p)) next.delete(p); else next.add(p);
                  return next;
                })}
              />
              <span>
                <b>{PURPOSE_LABELS[p] || p}</b>
                <span style={{ opacity: 0.7 }}>
                  {' — '}{PURPOSE_DESCRIPTIONS[p] || ''}
                </span>
              </span>
            </label>
          ))}
          <p style={{ fontSize: 12, opacity: 0.65, margin: '8px 0 12px' }}>
            Ticked to match this domain&rsquo;s standing policy. Leave none
            ticked and the platform offers that policy anyway — it will not send
            an empty request.
          </p>
        </>
      )}

      {result && (
        <>
          <p style={{ fontSize: 13, margin: '0 0 10px',
                      color: dark ? '#8fd0a6' : '#2E7D4F', fontWeight: 600 }}>
            {result.already_pending
              ? 'A request was already out — here is that same link.'
              : 'Request created.'}
          </p>
          <div style={dt}>Offering</div>
          <div style={dd}>
            {result.offered_purposes.map(p => PURPOSE_LABELS[p] || p).join(', ') || '—'}
          </div>
          <div style={dt}>Link expires</div>
          <div style={dd}>{formatWhen(result.expires_at)}</div>

          <div style={dt}>Send them this link</div>
          <input
            readOnly
            value={link ?? ''}
            onFocus={e => e.currentTarget.select()}
            style={{
              ...mono, fontSize: 12, width: '100%', boxSizing: 'border-box',
              padding: '7px 9px', borderRadius: 6, marginTop: 4,
              border: `1px solid ${dark ? '#5a5c66' : '#bcbfc7'}`,
              background: dark ? '#12141c' : '#f7f7f9',
              color: dark ? '#e8e8ea' : '#1E2130',
            }}
          />
          {!result.portal_url && (
            <p style={{ fontSize: 12, color: '#A63D40', margin: '6px 0 0' }}>
              That is a path, not a full link: this platform has no portal
              address configured, so it cannot say which site to put in front of
              it. Set <code>PORTAL_BASE_URL</code> in the API&rsquo;s config, or
              prefix the path with the portal&rsquo;s own address by hand.
            </p>
          )}
          <p style={{ fontSize: 12, opacity: 0.65, margin: '8px 0 0' }}>
            Anyone holding this link can answer as {displayName || 'this person'},
            so send it the way you would send anything else meant only for them.
          </p>
        </>
      )}

      {error && (
        <div style={{ color: '#A63D40', fontSize: 13, margin: '8px 0 0' }}>{error}</div>
      )}

      <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center',
                    flexWrap: 'wrap' }}>
        {!result && (
          <button type="button" style={{ ...primary, opacity: busy ? 0.6 : 1 }}
                  disabled={busy} onClick={send}>
            {busy ? 'Working…' : live ? 'Show the link again' : 'Send request'}
          </button>
        )}
        {result && link && (
          <button type="button" style={button} onClick={() => copy(link)}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
        )}
        {openId !== null && (
          <button type="button" style={{ ...button, color: '#A63D40', opacity: busy ? 0.6 : 1 }}
                  disabled={busy} onClick={() => cancel(openId)}>
            Cancel request
          </button>
        )}
      </div>
    </div>
  );
};

// What one person's consent record says, and the receipt standing behind it.
const UserConsentPopup: React.FC<{
  uid: string;
  party: ConsentParty | null;
  purposes: string[];
  mayRequest: boolean;
  pendingRequest: PendingConsentRequest | null;
  defaultPurposes: string[];
  canModify: boolean;
  displayName: string | null;
  dark: boolean;
  onChanged: () => void;
  onClose: () => void;
}> = ({ uid, party, purposes, mayRequest, pendingRequest, defaultPurposes,
        canModify, displayName, dark, onChanged, onClose }) => {
  const [verified, setVerified] =
    useState<'idle' | 'checking' | 'valid' | 'invalid' | string>('idle');
  const [viewReceipt, setViewReceipt] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes, and focus moves into the panel so a keyboard user is not
  // left tabbing through the table behind the overlay. Escape is ignored while
  // the receipt is open on top — that modal owns the key then.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !viewReceipt) onClose();
    };
    document.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => { document.removeEventListener('keydown', onKey); };
  }, [onClose, viewReceipt]);

  // The page behind the overlay is stopped from scrolling for as long as this
  // panel exists, and for no longer.
  //
  // Its own effect, with NO dependencies, because a nested modal opens on top
  // of this one. Locking from the Escape effect above meant re-running it
  // whenever viewReceipt changed — and a re-run restores the body, re-reads it, and
  // saves whatever the CHILD modal had already set. Closing both then put
  // `overflow: hidden` back and left the host page unscrollable, with no
  // overlay on screen to explain why.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);


  // Re-checks the Ed25519 signature. The platform verifies server-side, but the
  // response also carries the signed bytes, the signature and the public key,
  // so this is a check anyone can repeat — that is what makes it a receipt
  // rather than a log line.
  const verify = async (receiptId: string) => {
    setVerified('checking');
    try {
      const res = await siprec.verifyReceipt(receiptId);
      setVerified(res.signature_valid ? 'valid' : 'invalid');
    } catch (e: any) {
      setVerified(e?.message || 'check failed');
    }
  };

  const surface = dark ? '#1c1f2b' : '#ffffff';
  const ink = dark ? '#e8e8ea' : '#1E2130';
  const hairline = '1px solid rgba(128,128,128,0.28)';
  const mono: React.CSSProperties = {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    wordBreak: 'break-all',
  };
  // Horizon's stylesheet flattens a bare <button> into what reads as static
  // text, so every control carries its own chrome.
  const button: React.CSSProperties = {
    appearance: 'none', border: hairline, borderRadius: 6,
    background: dark ? '#262a38' : '#f5f5f7', color: ink,
    cursor: 'pointer', fontSize: 13, padding: '5px 11px', lineHeight: 1.4,
    whiteSpace: 'nowrap', fontFamily: 'inherit',
  };
  const primary: React.CSSProperties = {
    ...button, background: '#C8862F', borderColor: '#C8862F', color: '#ffffff',
    fontWeight: 600,
  };
  const card: React.CSSProperties = {
    border: hairline, borderRadius: 8, padding: '12px 14px', marginTop: 12,
  };
  const dt: React.CSSProperties = { fontWeight: 600, opacity: 0.7, fontSize: 12 };
  const dd: React.CSSProperties = { margin: '2px 0 10px 0', fontSize: 13 };

  const granted = party?.purposes ?? [];
  const receipt = party?.receipt ?? null;
  const name = party?.party_name || displayName || uid;

  return createPortal(
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 2147483000,
        background: 'rgba(0,0,0,0.45)', display: 'flex',
        alignItems: 'flex-start', justifyContent: 'center',
        padding: '5vh 16px', overflowY: 'auto',
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Consent for ${name}`}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{
          background: surface, color: ink, borderRadius: 10, border: hairline,
          width: 'min(680px, 100%)', padding: 20,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          boxShadow: '0 18px 48px rgba(0,0,0,0.35)', outline: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start',
                      justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 17 }}>
              Consent — {name}{party?.is_you ? ' (you)' : ''}
            </h3>
            {/* The user ID alone. A device address here would imply the
                decision is tied to one handset, when it is not. */}
            <div style={{ ...mono, fontSize: 11, opacity: 0.65, marginTop: 3 }}>
              {party?.party_uid ?? uid}
            </div>
          </div>
          <button type="button" onClick={onClose} style={button} aria-label="Close">
            Close
          </button>
        </div>

        {/* The position in words before the grid. A row of ticks states what
            was agreed without ever saying whether anything was — and with no
            record at all there is nothing to tick, so the sentence has to
            carry the whole answer. */}
        <div style={{
          ...card,
          fontSize: 13, fontWeight: 600,
          color: !party ? (dark ? '#d8b877' : '#8a6412')
            : granted.length > 0 ? '#2E7D4F' : '#A63D40',
          borderColor: !party ? (dark ? '#6b5624' : '#e6cfa6')
            : granted.length > 0 ? '#2E7D4F' : '#A63D40',
        }}>
          {!party
            ? 'No consent record — this person has not been on a recorded conversation.'
            : granted.length > 0
              ? `Consent given for ${granted.map(p => PURPOSE_LABELS[p] || p).join(', ')}.`
              : party.proof_type
                ? 'Consent withdrawn — no purpose is currently permitted.'
                : 'No decision recorded — this domain’s default applies.'}
        </div>

        {/* No record: explain the state, then offer the only thing that
            legitimately fills it. */}
        {!party && (
          <>
            <div style={card}>
              <p style={{ fontSize: 13, opacity: 0.85, margin: 0 }}>
                A person enters the consent registry when they first appear on a
                recorded call, which is when the recorder can see who they are
                and apply this domain&rsquo;s standing policy. Until then there
                is nothing recorded for them, and this domain&rsquo;s default
                would govern their first conversation.
              </p>
            </div>
            {mayRequest ? (
              <RequestConsent
                uid={uid}
                displayName={displayName}
                pending={pendingRequest}
                defaultPurposes={defaultPurposes}
                allPurposes={purposes}
                dark={dark}
                onChanged={onChanged}
                styles={{ button, primary, card, mono, dt, dd }}
              />
            ) : (
              <div style={card}>
                <p style={{ fontSize: 13, opacity: 0.8, margin: 0 }}>
                  Your role can view consent but not ask for it, so there is
                  nothing to do here.
                </p>
              </div>
            )}
          </>
        )}

        {/* Everything below describes a record, so none of it renders without
            one. */}
        {party && (
        <>
        <div style={card}>
          <h4 style={{ margin: '0 0 10px 0', fontSize: 14 }}>Purposes</h4>
          {purposes.length === 0 ? (
            <div style={{ fontSize: 13, opacity: 0.7 }}>
              The platform reported no purpose vocabulary.
            </div>
          ) : purposes.map(p => {
            const on = granted.includes(p);
            return (
              <div key={p} style={{ display: 'flex', gap: 10, alignItems: 'baseline',
                                    padding: '5px 0' }}>
                <span aria-hidden style={{
                  fontWeight: 700, width: 14, flex: '0 0 14px',
                  color: on ? '#2E7D4F' : '#A63D40',
                }}>{on ? '✓' : '✗'}</span>
                <span style={{ fontSize: 13 }}>
                  <b>{PURPOSE_LABELS[p] || p}</b>
                  <span style={{ opacity: 0.7 }}>
                    {' — '}{PURPOSE_DESCRIPTIONS[p] || ''}
                  </span>
                  <span style={{ opacity: 0.75 }}>
                    {' · '}{on ? 'permitted' : 'not permitted'}
                  </span>
                </span>
              </div>
            );
          })}
        </div>

        <div style={card}>
          <h4 style={{ margin: '0 0 10px 0', fontSize: 14 }}>How it was recorded</h4>

          <div style={dt}>Basis</div>
          <div style={dd}>{sourceLabel(party.source)}</div>

          <div style={dt}>Proof</div>
          <div style={dd}>
            {party.proof_type
              ? (PROOF_LABELS[party.proof_type] || party.proof_type)
              : <span style={{ opacity: 0.7 }}>none recorded</span>}
            {/* For portal_receipt the reference IS the receipt id, which the
                receipt card below already shows — repeated here it only reads
                as a second identifier. Shown when it points at something
                else. */}
            {party.proof_reference && party.proof_reference !== receipt?.receipt_id && (
              <div style={{ ...mono, fontSize: 11, opacity: 0.65, marginTop: 2 }}>
                {party.proof_reference}
              </div>
            )}
          </div>

          <div style={dt}>Conversations</div>
          <div style={{ ...dd, marginBottom: 0 }}>
            {party.conversations} stored conversation
            {party.conversations === 1 ? '' : 's'} this decision reaches
            {party.last_seen_at && (
              <span style={{ opacity: 0.7 }}>
                {' · '}last seen {formatWhen(party.last_seen_at)}
              </span>
            )}
          </div>
        </div>

        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline',
                        justifyContent: 'space-between', gap: 10 }}>
            <h4 style={{ margin: 0, fontSize: 14 }}>Signed receipt</h4>
            {receipt?.agreement_version && (
              <span style={{ fontSize: 11, opacity: 0.65 }}>
                agreement {receipt.agreement_version}
              </span>
            )}
          </div>

          {!receipt ? (
            <p style={{ fontSize: 13, opacity: 0.75, margin: '8px 0 0' }}>
              No receipt has been issued for this person. A receipt is created
              when a decision is made — through the data-subject portal or the
              Consent page — so a state that came from a prior agreement or a
              domain default has none.
            </p>
          ) : (
            <>
              <div style={{ ...mono, fontSize: 11, opacity: 0.8, margin: '8px 0 6px' }}>
                {receipt.receipt_id}
              </div>
              <div style={{ fontSize: 13 }}>
                {receipt.action === 'revoke' ? 'Withdrawal' : 'Grant'}
                {receipt.signed_at ? ` · signed ${formatWhen(receipt.signed_at)}` : ''}
                {typeof receipt.applied_to_existing === 'number'
                  ? ` · ${receipt.applied_to_existing} existing conversation${
                      receipt.applied_to_existing === 1 ? '' : 's'} updated`
                  : ''}
              </div>

              <div style={{ marginTop: 12, display: 'flex', gap: 8,
                            alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  style={button}
                  onClick={() => setViewReceipt(true)}
                  title="Show the signed receipt, its signature and the public key"
                >
                  View receipt
                </button>
                <button
                  type="button"
                  style={{ ...button, opacity: verified === 'checking' ? 0.6 : 1 }}
                  disabled={verified === 'checking'}
                  onClick={() => void verify(receipt.receipt_id)}
                  title="Re-check the Ed25519 signature over the receipt bytes"
                >
                  {verified === 'checking' ? 'Checking…' : 'Verify signature'}
                </button>
                {verified !== 'idle' && verified !== 'checking' && (
                  <span style={{
                    fontSize: 13, fontWeight: 600,
                    color: verified === 'valid' ? '#2E7D4F' : '#A63D40',
                  }}>
                    {verified === 'valid' ? '✓ valid'
                      : verified === 'invalid' ? '✗ INVALID' : verified}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
        </>
        )}

        {/* Where a change is made. This popup does not offer one on purpose —
            see the note at the top of this file — so it says where to go
            rather than leaving the reader to wonder if it is missing. Only
            said where there IS a decision to change; with no record the card
            above has already explained what can be done instead. */}
        {party && (
          <p style={{ fontSize: 12, opacity: 0.7, margin: '14px 0 0' }}>
            {canModify
              ? 'This view is read-only. Consent is changed on the Consent page, which shows the agreement and issues a new signed receipt.'
              : 'This view is read-only, and your role may view consent but not change it.'}
          </p>
        )}
      </div>

      {/* On top of this panel rather than instead of it, so closing the
          receipt returns to the record it belongs to. */}
      {viewReceipt && receipt && (
        <ReceiptModal receiptId={receipt.receipt_id} dark={dark}
                      onClose={() => setViewReceipt(false)} />
      )}
    </div>,
    document.body,
  );
};

// Consent for one row of Horizon's Users table — what is recorded, or the way
// to ask for it when nothing is.
//
// Drawn on every row the caller may either see a record for or ask, which on a
// Users page is usually all of them; a seat only acquires a record once it has
// been on a recorded conversation, so "nothing recorded yet" is the common
// state rather than an edge case. Absent only where the platform says this
// caller may do neither — which is its answer to give, not this bundle's.
export const UserConsentButton: React.FC<HorizonExtensionProps> = ({ context }) => {
  const rawRow = (context?.pageContext as { row?: unknown } | undefined)?.row;
  const row = rawRow && typeof rawRow === 'object'
    ? rawRow as Record<string, unknown> : null;

  // The route's domain, and then the signed-in user's, for a Users view that
  // does not put the domain on the row — /home/domain/users is the caller's
  // own domain and never names it in the path.
  const fallbackDomain = context?.params?.domain
    ?? context?.user?.domain
    ?? hostProps.user?.domain
    ?? null;

  const candidates = candidateUidsFor(row, fallbackDomain);
  const {
    state, party, purposes, canModify, mayRequest, pendingRequest,
    defaultPurposes, uid,
  } = useUserConsent(hostProps, candidates);
  const [open, setOpen] = useState(false);
  // Whether anything was written while the popup was open. The refresh is
  // deferred to close deliberately: dropping the cache entry mid-flight sends
  // this row back to 'loading', which unmounts the popup — and it would take
  // the freshly minted link down with it, moments after someone pressed the
  // button that created it.
  const changed = useRef(false);
  const dark = context?.theme === 'dark';

  // Nothing to show and nothing to offer. `uid` is null in exactly the same
  // cases, but checking it separately is what makes the popup's non-null uid
  // real rather than asserted.
  if (state !== 'ready' || !uid || (!party && !mayRequest)) return null;

  const first = typeof row?.['name-first-name'] === 'string' ? row['name-first-name'] : '';
  const last = typeof row?.['name-last-name'] === 'string' ? row['name-last-name'] : '';
  const displayName = [first, last].filter(Boolean).join(' ').trim() || null;

  // Three states, three things to say. The icon changes too: a record is a
  // fact about this person, an outstanding request is a fact about what has
  // been done, and neither is an invitation to do something.
  const [icon, glyph, label] = party
    ? ['material-symbols:verified-user-outline', '✓',
       party.purposes.length > 0
         ? `Consent for this user (${party.purposes.length} purpose${
             party.purposes.length === 1 ? '' : 's'} permitted)`
         : 'Consent for this user (none permitted)']
    : pendingRequest
      ? ['material-symbols:hourglass-top-outline', '…',
         'Consent requested — not answered yet']
      : ['material-symbols:person-alert-outline', '?',
         'No consent recorded — ask this user for consent'];

  return (
    <>
      <RowIconButton
        ui={context?.ui}
        icon={icon}
        glyph={glyph}
        label={label}
        dark={dark}
        onClick={() => setOpen(true)}
      />
      {open && (
        <UserConsentPopup
          uid={uid}
          party={party}
          purposes={purposes}
          mayRequest={mayRequest}
          pendingRequest={pendingRequest}
          defaultPurposes={defaultPurposes}
          canModify={canModify}
          displayName={displayName}
          dark={dark}
          // A minted or cancelled request changes what this row should say,
          // and the platform is the authority on what it now says — so drop
          // what is cached and let the next render ask again. On close, not
          // now: see `changed` above.
          onChanged={() => { changed.current = true; }}
          onClose={() => {
            setOpen(false);
            if (changed.current) {
              changed.current = false;
              forgetUserConsent(uid);
            }
          }}
        />
      )}
    </>
  );
};
