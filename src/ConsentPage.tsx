import React, { useEffect, useState, useCallback } from 'react';
import { HorizonProps } from './horizon';
import {
  siprec, ConsentParty, ConsentAgreement, AccessInfo, Identity,
  scopedTitle, visibilityLabel,
} from './api';
import { PURPOSE_LABELS, PROOF_LABELS } from './purposes';
import { SelfConsent } from './SelfConsent';
import { ReceiptModal } from './ReceiptModal';

// Per-purpose consent for whoever the signed-in user is entitled to act on.
//
// Saving goes through the same path as the data-subject portal: each of the
// person's vCons is rewritten, the consent index and lifecycle ledger are
// updated, and an Ed25519-signed receipt is issued. A decision made here and
// one made in the portal are indistinguishable as evidence.
//
// Consent is held against the user ID, never a device address — the same
// person may take calls on several handsets, and the decision covers all of
// them.

const cell: React.CSSProperties = { padding: '8px 10px', verticalAlign: 'top' };

export const ConsentPage: React.FC<{ host: Partial<HorizonProps> }> = ({ host }) => {
  const [parties, setParties] = useState<ConsentParty[]>([]);
  const [purposes, setPurposes] = useState<string[]>([]);
  const [agreement, setAgreement] = useState<ConsentAgreement | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [access, setAccess] = useState<AccessInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Verification results by receipt id, so a checked receipt stays checked.
  const [verified, setVerified] = useState<Record<string, 'checking' | 'valid' | 'invalid' | string>>({});
  // The receipt being viewed, if any. Shown in place rather than a new tab —
  // leaving the page would lose the list and cost a remote reload to return.
  const [viewReceiptId, setViewReceiptId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await siprec.consent(host);
      setParties(data.parties);
      setPurposes(data.purposes);
      setAgreement(data.agreement);
      setIdentity(data.identity);
      setAccess(data.access);
    } catch (e: any) {
      setError(e.message || 'Could not load consent');
    } finally {
      setLoading(false);
    }
  }, [host]);

  useEffect(() => { load(); }, [load]);

  const toggle = async (party: ConsentParty, purpose: string) => {
    const next = party.purposes.includes(purpose)
      ? party.purposes.filter(p => p !== purpose)
      : [...party.purposes, purpose];
    setBusy(party.party_uid);
    setError(null);
    setNotice(null);
    try {
      const res = await siprec.setConsent(host, party.party_uid, next);
      applySaved(party.party_uid, next, res);
      setNotice(
        `Saved for ${party.party_name || party.party_uid}. Receipt ${res.receipt?.receipt_id} — ` +
        `${res.existing_conversations_updated} existing recording(s) updated.`);
    } catch (e: any) {
      setError(e.message || 'Could not save consent');
    } finally {
      setBusy(null);
    }
  };

  // Re-checks the Ed25519 signature. The platform verifies server-side, but the
  // response also carries the signed bytes, signature and public key, so this
  // is a check anyone can repeat — that is what makes it a receipt rather than
  // a log line.
  const verify = async (receiptId: string) => {
    setVerified(v => ({ ...v, [receiptId]: 'checking' }));
    try {
      const res = await siprec.verifyReceipt(receiptId);
      setVerified(v => ({ ...v, [receiptId]: res.signature_valid ? 'valid' : 'invalid' }));
    } catch (e: any) {
      setVerified(v => ({ ...v, [receiptId]: e.message || 'check failed' }));
    }
  };

  const dark = host.theme === 'dark';
  const readOnly = access?.can_modify_consent === false;
  const title = scopedTitle('Consent', access?.visibility);

  // Someone who can only see themselves is being asked about their own data,
  // so they get the agreement-led view rather than a one-row grid. Keyed on
  // visibility rather than on the row count: a manager whose domain happens to
  // hold one person is still administering someone else's consent, and should
  // see the administrative form.
  const self = access?.visibility === 'own' ? parties.find(p => p.is_you) ?? parties[0] : undefined;

  // Fold a saved decision back into the list so the summary reflects it without
  // a refetch. Mirrors what the platform records: any save stamps the consent
  // with portal_receipt proof referencing the new receipt.
  const applySaved = (uid: string, next: string[], res: any) => {
    setParties(prev => prev.map(p => p.party_uid === uid ? {
      ...p,
      purposes: next,
      proof_type: 'portal_receipt',
      proof_reference: res.receipt?.receipt_id ?? p.proof_reference,
      source: p.is_you ? 'party' : 'console',
      receipt: res.receipt ? {
        receipt_id: res.receipt.receipt_id,
        action: res.receipt.action,
        purposes: res.receipt.purposes ?? next,
        applied_to_existing: res.existing_conversations_updated,
        agreement_version: res.receipt.agreement?.version ?? null,
        signed_at: res.receipt.signed_at ?? null,
      } : p.receipt,
    } : p));
  };

  // Horizon's stylesheet flattens bare <a> and <button> inside an app — an
  // anchor inherits body colour with no underline, and a button loses its
  // chrome — so both read as static text. These carry their own affordance.
  const actionStyle: React.CSSProperties = {
    display: 'inline-block',
    fontSize: 11,
    lineHeight: 1.6,
    padding: '2px 8px',
    borderRadius: 4,
    border: `1px solid ${dark ? '#5a5c66' : '#bcbfc7'}`,
    background: dark ? '#2a2b31' : '#ffffff',
    color: dark ? '#9ec1ff' : '#1a5fb4',
    textDecoration: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
  };

  return (
    <div style={{ padding: 24, color: dark ? '#e8e8ea' : '#1E2130', fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      {access && identity && (
        <p style={{ opacity: 0.7, marginTop: -8, maxWidth: 720 }}>
          {access.visibility === 'own' ? (
            <>
              {identity.display_name ? <b>{identity.display_name}</b> : null}
              {identity.display_name ? ' · ' : null}
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>
                {identity.party_uid}
              </span>
              {' — '}your decision applies to you across every device you use, and is
              recorded with a signed receipt.
            </>
          ) : (
            <>
              Consent for {visibilityLabel(access.visibility, identity)} — your role is{' '}
              <b>{identity.scope}</b>. Each decision is recorded with a signed receipt and
              applies to the person across every device they use.
            </>
          )}
        </p>
      )}
      {/* In the self view the same point is made inline, next to the control it
          disables — a banner here would just repeat it. */}
      {readOnly && !self && (
        <div style={{ background: '#F3E7D2', border: '1px solid #e6cfa6', padding: 10, borderRadius: 6, marginBottom: 12 }}>
          Your role can view consent but not change it.
        </div>
      )}

      {error && <div style={{ color: '#A63D40', marginBottom: 10 }}>{error}</div>}
      {notice && !self && <div style={{ color: '#2A3060', marginBottom: 10 }}>{notice}</div>}

      {/* Self view: one person, their own data, agreement-led. */}
      {!loading && access?.visibility === 'own' && agreement && (
        self ? (
          <SelfConsent
            host={host}
            party={self}
            purposes={purposes}
            agreement={agreement}
            readOnly={readOnly}
            onSaved={applySaved}
          />
        ) : (
          // No registry row yet — nothing to change, and the write endpoint
          // would 404. Say why rather than showing an inert form.
          <div style={{ border: '1px solid rgba(128,128,128,0.3)', borderRadius: 10,
                        padding: '16px 18px', maxWidth: 720 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>No consent record yet</h3>
            <p style={{ margin: 0, opacity: 0.8, fontSize: 14 }}>
              You will appear here once you have taken part in a recorded conversation.
              Until then there is nothing to consent to, and your domain&rsquo;s default
              applies.
            </p>
          </div>
        )
      )}

      {/* The table outgrew the viewport once Proof and Receipt were added, and
          the overflow was silently clipped — the Receipt column simply was not
          reachable. Scroll it within its own container rather than letting the
          page decide. */}
      {loading ? <div>Loading…</div> : access?.visibility === 'own' ? null : (
        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
        <table style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid rgba(128,128,128,0.3)' }}>
              <th style={cell}>Person</th>
              <th style={cell}>User ID</th>
              {purposes.map(p => <th key={p} style={cell}>{PURPOSE_LABELS[p] || p}</th>)}
              <th style={cell}>Calls</th>
              <th style={cell}>Basis</th>
              <th style={cell}>Proof</th>
              <th style={cell}>Receipt</th>
            </tr>
          </thead>
          <tbody>
            {parties.length === 0 ? (
              <tr><td style={cell} colSpan={purposes.length + 6}>No consent records visible to you.</td></tr>
            ) : parties.map(party => (
              <tr key={party.party_uid}
                  style={{ borderBottom: '1px solid rgba(128,128,128,0.15)',
                           background: party.is_you ? 'rgba(200,134,47,0.08)' : undefined }}>
                <td style={cell}>
                  {party.party_name || '—'}{party.is_you ? <b> (you)</b> : null}
                </td>
                {/* The user ID alone: the device address would imply the
                    consent is tied to one handset, when it is not. */}
                <td style={{ ...cell, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                  {party.party_uid}
                </td>
                {purposes.map(p => (
                  <td key={p} style={cell}>
                    <input type="checkbox"
                      checked={party.purposes.includes(p)}
                      disabled={readOnly || busy === party.party_uid}
                      onChange={() => toggle(party, p)}
                      title={readOnly ? 'Your role cannot change consent' : PURPOSE_LABELS[p] || p} />
                  </td>
                ))}
                <td style={cell}>{party.vcon_count}</td>
                <td style={{ ...cell, fontSize: 12, opacity: 0.75 }}>
                  {party.source === 'party' ? 'self-asserted'
                    : party.source === 'console' ? 'set by an administrator'
                    : 'domain default'}
                </td>

                {/* How the consent was obtained, and the evidence reference.
                    An unstamped row says so plainly rather than showing a dash
                    that could read as "fine". */}
                <td style={{ ...cell, fontSize: 12 }}>
                  {party.proof_type ? (
                    <>
                      <div>{PROOF_LABELS[party.proof_type] || party.proof_type}</div>
                      {/* For portal_receipt the reference IS the receipt id, and
                          the Receipt column already shows it — repeating it here
                          only cost width. Show the reference when it points at
                          something else. */}
                      {party.proof_reference
                        && party.proof_reference !== party.receipt?.receipt_id && (
                        <div style={{
                          fontFamily: 'ui-monospace, monospace', fontSize: 11, opacity: 0.6,
                          maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }} title={party.proof_reference}>
                          {party.proof_reference}
                        </div>
                      )}
                    </>
                  ) : <span style={{ opacity: 0.6 }}>none recorded</span>}
                </td>

                {/* The signed receipt, and a way to check it. */}
                <td style={{ ...cell, fontSize: 12 }}>
                  {party.receipt ? (
                    <>
                      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}
                           title={party.receipt.receipt_id}>
                        {party.receipt.receipt_id}
                      </div>
                      <div style={{ opacity: 0.7 }}>
                        {party.receipt.action}
                        {party.receipt.signed_at
                          ? ` · ${new Date(party.receipt.signed_at).toLocaleDateString()}` : ''}
                        {party.receipt.agreement_version ? ` · ${party.receipt.agreement_version}` : ''}
                      </div>
                      <div style={{ marginTop: 5, display: 'flex', gap: 6, alignItems: 'center',
                                    flexWrap: 'wrap' }}>
                        <button
                          onClick={() => setViewReceiptId(party.receipt!.receipt_id)}
                          style={actionStyle}
                          title="Show the signed receipt, its signature and the public key">
                          View
                        </button>
                        <button
                          onClick={() => verify(party.receipt!.receipt_id)}
                          disabled={verified[party.receipt.receipt_id] === 'checking'}
                          style={actionStyle}
                          title="Re-check the Ed25519 signature over the receipt bytes">
                          {verified[party.receipt.receipt_id] === 'checking' ? 'Checking…' : 'Verify'}
                        </button>
                        {(() => {
                          const state = verified[party.receipt!.receipt_id];
                          if (!state || state === 'checking') return null;
                          const ok = state === 'valid';
                          return (
                            <span style={{ color: ok ? '#2E7D4F' : '#A63D40', fontWeight: 600 }}>
                              {ok ? '✓ valid'
                                : state === 'invalid' ? '✗ INVALID' : state}
                            </span>
                          );
                        })()}
                      </div>
                    </>
                  ) : <span style={{ opacity: 0.6 }}>no receipt</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {viewReceiptId && (
        <ReceiptModal receiptId={viewReceiptId} dark={dark}
                      onClose={() => setViewReceiptId(null)} />
      )}
    </div>
  );
};
