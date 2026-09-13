import React, { useState } from 'react';
import { HorizonProps } from './horizon';
import { siprec, ConsentParty, ConsentAgreement } from './api';
import { PURPOSE_LABELS, PURPOSE_DESCRIPTIONS, PROOF_LABELS } from './purposes';
import { ReceiptModal } from './ReceiptModal';

// One person's own consent, for someone who can only see themselves.
//
// A table with a single row is a poor way to ask somebody for consent: it
// presents a legal decision as a spreadsheet cell, and a bare checkbox records
// an agreement without ever showing what was agreed to. So the self view states
// the current position in words, and any change goes through the agreement —
// the same text, version and signed receipt the data-subject portal uses.
//
// The checkbox-per-purpose grid still exists for managers looking at many
// people at once, where the compact form is the right one and the person
// deciding is not the data subject.

type Stage = 'summary' | 'agreement' | 'done';

export const SelfConsent: React.FC<{
  host: Partial<HorizonProps>;
  party: ConsentParty;
  purposes: string[];
  agreement: ConsentAgreement;
  readOnly: boolean;
  onSaved: (party_uid: string, purposes: string[], result: any) => void;
}> = ({ host, party, purposes, agreement, readOnly, onSaved }) => {
  const [stage, setStage] = useState<Stage>('summary');
  const [selected, setSelected] = useState<Set<string>>(new Set(party.purposes));
  const [applyExisting, setApplyExisting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null);
  const [action, setAction] = useState<'grant' | 'revoke'>('grant');
  const [verifyState, setVerifyState] = useState<string | null>(null);
  // Shown in place rather than a new tab: this is the page where the person
  // makes the decision, and losing it to read their own receipt is a poor trade.
  const [viewReceiptId, setViewReceiptId] = useState<string | null>(null);

  const dark = host.theme === 'dark';
  const hasDecided = party.proof_type !== null || party.purposes.length > 0;

  const card: React.CSSProperties = {
    border: `1px solid ${dark ? '#3a3c44' : '#E1E2EA'}`,
    borderRadius: 10,
    padding: '16px 18px',
    marginBottom: 16,
    background: dark ? '#1b1c22' : '#ffffff',
    maxWidth: 720,
  };
  const cardHead: React.CSSProperties = {
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
    marginBottom: 10, gap: 12,
  };
  const button: React.CSSProperties = {
    fontSize: 13, padding: '7px 14px', borderRadius: 6, cursor: 'pointer',
    border: `1px solid ${dark ? '#5a5c66' : '#bcbfc7'}`,
    background: dark ? '#2a2b31' : '#ffffff',
    color: dark ? '#e8e8ea' : '#1E2130',
    fontFamily: 'inherit',
  };
  const primary: React.CSSProperties = {
    ...button, background: '#C8862F', borderColor: '#C8862F', color: '#ffffff',
    fontWeight: 600,
  };
  const danger: React.CSSProperties = {
    ...button, color: '#A63D40', borderColor: dark ? '#7a4446' : '#e0b9b9',
  };
  const pre: React.CSSProperties = {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap',
    background: dark ? '#121318' : '#f6f6f8',
    border: `1px solid ${dark ? '#33343c' : '#e4e5ea'}`,
    borderRadius: 6, padding: 12, margin: 0,
  };

  const submit = async (act: 'grant' | 'revoke') => {
    const next = act === 'revoke' ? [] : Array.from(selected);
    if (act === 'revoke' && !window.confirm(
      'Withdraw your consent? External applications will lose access to your conversations.')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await siprec.setConsent(host, party.party_uid, next, applyExisting);
      setResult(res);
      setAction(act);
      setStage('done');
      setSelected(new Set(next));
      onSaved(party.party_uid, next, res);
    } catch (e: any) {
      setError(e.message || 'Your decision could not be recorded. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (receiptId: string) => {
    setVerifyState('checking');
    try {
      const res = await siprec.verifyReceipt(receiptId);
      setVerifyState(res.signature_valid ? 'valid' : 'invalid');
    } catch (e: any) {
      setVerifyState(e.message || 'check failed');
    }
  };

  // The receipt, its signature and the public key, as a file the person keeps.
  // Everything needed to verify it later without this platform's help.
  const downloadReceipt = () => {
    if (!result?.receipt) {
      return;
    }
    const bundle = {
      receipt: result.receipt,
      signature_b64: result.signature_b64,
      public_key_b64: result.public_key_b64,
      algorithm: 'Ed25519',
      verify: 'Ed25519-verify(signature, canonical receipt JSON bytes, public_key)',
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${result.receipt.receipt_id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ------------------------------------------------------------------ done
  if (stage === 'done' && result) {
    return (
      <div style={card}>
        <div style={cardHead}>
          <h3 style={{ margin: 0, fontSize: 16 }}>
            {action === 'grant' ? 'Consent recorded' : 'Consent withdrawn'}
          </h3>
          <span style={{ fontSize: 12, opacity: 0.65, fontFamily: 'ui-monospace, monospace' }}>
            {result.receipt?.receipt_id}
          </span>
        </div>
        <p style={{ marginTop: 0, opacity: 0.8, fontSize: 14 }}>
          Your decision is now in force
          {result.existing_conversations_updated > 0 ? (
            <> and was applied to {result.existing_conversations_updated} existing
            conversation{result.existing_conversations_updated === 1 ? '' : 's'}</>
          ) : null}. Below is your signed receipt — keep a copy. It can be verified at
          any time against the platform&rsquo;s published public key.
        </p>
        <pre style={{ ...pre, maxHeight: 260, overflow: 'auto' }}>
          {JSON.stringify(result.receipt, null, 2)}
        </pre>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button style={primary} onClick={downloadReceipt}>Download signed receipt</button>
          <button style={button} onClick={() => { setResult(null); setStage('summary'); }}>
            Done
          </button>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------- agreement
  if (stage === 'agreement') {
    return (
      <>
        <div style={card}>
          <div style={cardHead}>
            <h3 style={{ margin: 0, fontSize: 16 }}>The agreement</h3>
            <span style={{ fontSize: 12, opacity: 0.65 }}>version {agreement.version}</span>
          </div>
          <pre style={{ ...pre, maxHeight: 260, overflow: 'auto' }}>{agreement.text}</pre>
        </div>

        <div style={card}>
          <div style={cardHead}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Your choices</h3>
            <span style={{ fontSize: 12, opacity: 0.65 }}>select what you consent to</span>
          </div>

          {purposes.map(p => (
            <label key={p} style={{
              display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 0',
              cursor: busy ? 'default' : 'pointer',
            }}>
              <input type="checkbox" disabled={busy}
                checked={selected.has(p)}
                onChange={e => setSelected(prev => {
                  const next = new Set(prev);
                  if (e.target.checked) { next.add(p); } else { next.delete(p); }
                  return next;
                })} />
              <span style={{ fontSize: 14 }}>
                <b>{PURPOSE_LABELS[p] || p}</b>{' '}
                <span style={{ opacity: 0.7 }}>{PURPOSE_DESCRIPTIONS[p] || ''}</span>
              </span>
            </label>
          ))}

          {party.conversations > 0 && (
            <label style={{
              display: 'flex', gap: 10, alignItems: 'baseline', padding: '11px 0 4px',
              marginTop: 8, borderTop: `1px solid ${dark ? '#33343c' : '#E1E2EA'}`,
              cursor: busy ? 'default' : 'pointer',
            }}>
              <input type="checkbox" disabled={busy} checked={applyExisting}
                onChange={e => setApplyExisting(e.target.checked)} />
              <span style={{ fontSize: 13, opacity: 0.85 }}>
                Also apply my decision to my {party.conversations} existing recorded
                conversation{party.conversations === 1 ? '' : 's'}
              </span>
            </label>
          )}

          {error && <div style={{ color: '#A63D40', marginTop: 10, fontSize: 13 }}>{error}</div>}

          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button style={primary} disabled={busy || selected.size === 0}
              onClick={() => submit('grant')}>
              {busy ? 'Recording your decision…' : 'I consent to the selected purposes'}
            </button>
            <button style={danger} disabled={busy} onClick={() => submit('revoke')}>
              Withdraw all my consent
            </button>
            <button style={button} disabled={busy}
              onClick={() => { setStage('summary'); setError(null); setSelected(new Set(party.purposes)); }}>
              Cancel
            </button>
          </div>
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 10 }}>
            Every decision produces a cryptographically signed receipt you can download and
            independently verify.
          </div>
        </div>
      </>
    );
  }

  // ---------------------------------------------------------------- summary
  return (
    <div style={card}>
      <div style={cardHead}>
        <h3 style={{ margin: 0, fontSize: 16 }}>What you currently allow</h3>
        <span style={{ fontSize: 12, opacity: 0.65 }}>
          {party.conversations > 0
            ? `${party.conversations} recorded conversation${party.conversations === 1 ? '' : 's'}`
            : 'no recorded conversations yet'}
        </span>
      </div>

      {/* Every purpose is listed, allowed or not. Showing only what is granted
          would leave someone unable to see what they have declined. */}
      <div style={{ margin: '4px 0 14px' }}>
        {purposes.map(p => {
          const on = party.purposes.includes(p);
          return (
            <div key={p} style={{
              display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 0',
              borderBottom: `1px solid ${dark ? '#26272d' : '#f0f0f3'}`,
            }}>
              <span style={{
                fontSize: 11, fontWeight: 700, letterSpacing: 0.3,
                color: on ? '#2E7D4F' : (dark ? '#8b8d96' : '#8a8c95'),
                minWidth: 74,
              }}>
                {on ? '✓ ALLOWED' : '— NO'}
              </span>
              <span style={{ fontSize: 14 }}>
                <b>{PURPOSE_LABELS[p] || p}</b>{' '}
                <span style={{ opacity: 0.7 }}>{PURPOSE_DESCRIPTIONS[p] || ''}</span>
              </span>
            </div>
          );
        })}
      </div>

      {/* Where this state came from, and the evidence for it. */}
      <div style={{ fontSize: 13, opacity: 0.85, lineHeight: 1.7 }}>
        <div>
          <b>Basis:</b>{' '}
          {party.source === 'party' ? 'you set this yourself'
            : party.source === 'console' ? 'set on your behalf by an administrator'
            : 'your domain’s default — you have not made a decision yet'}
        </div>
        <div>
          <b>Proof:</b>{' '}
          {party.proof_type
            ? (PROOF_LABELS[party.proof_type] || party.proof_type)
            : 'none recorded'}
          {party.proof_reference && party.proof_reference !== party.receipt?.receipt_id
            && <span style={{ opacity: 0.7 }}> ({party.proof_reference})</span>}
        </div>
        {party.receipt && (
          <div>
            <b>Receipt:</b>{' '}
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
              {party.receipt.receipt_id}
            </span>
            <span style={{ opacity: 0.7 }}>
              {' · '}{party.receipt.action}
              {party.receipt.signed_at
                ? ` · ${new Date(party.receipt.signed_at).toLocaleDateString()}` : ''}
            </span>
          </div>
        )}
      </div>

      {party.receipt && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button style={{ ...button, color: dark ? '#9ec1ff' : '#1a5fb4' }}
                  onClick={() => setViewReceiptId(party.receipt!.receipt_id)}>
            View receipt
          </button>
          <button style={button} disabled={verifyState === 'checking'}
            onClick={() => verify(party.receipt!.receipt_id)}>
            {verifyState === 'checking' ? 'Checking…' : 'Verify signature'}
          </button>
          {verifyState && verifyState !== 'checking' && (
            <span style={{
              fontSize: 12, fontWeight: 600,
              color: verifyState === 'valid' ? '#2E7D4F' : '#A63D40',
            }}>
              {verifyState === 'valid' ? '✓ signature valid'
                : verifyState === 'invalid' ? '✗ signature INVALID' : verifyState}
            </span>
          )}
        </div>
      )}

      {error && <div style={{ color: '#A63D40', marginTop: 10, fontSize: 13 }}>{error}</div>}

      <div style={{ marginTop: 16, paddingTop: 14,
                    borderTop: `1px solid ${dark ? '#33343c' : '#E1E2EA'}` }}>
        {readOnly ? (
          <div style={{ fontSize: 13, opacity: 0.75 }}>
            Your role can view consent but not change it.
          </div>
        ) : (
          <>
            <button style={primary} onClick={() => setStage('agreement')}>
              {hasDecided ? 'Review agreement and change my consent'
                          : 'Review agreement and set my consent'}
            </button>
            <div style={{ fontSize: 12, opacity: 0.65, marginTop: 8 }}>
              You will see the full agreement before anything is recorded, and receive a
              signed receipt afterwards.
            </div>
          </>
        )}
      </div>

      {viewReceiptId && (
        <ReceiptModal receiptId={viewReceiptId} dark={dark}
                      onClose={() => setViewReceiptId(null)} />
      )}
    </div>
  );
};
