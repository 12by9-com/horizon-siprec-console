import React, { useEffect, useState } from 'react';
import { HorizonProps } from './horizon';
import { siprec, MyIdentity } from './api';

// "My addresses" — the person-identity plan's phase 4, in the self view.
//
// Your consent covers you, not one handset. Signing in to Horizon has already
// proved your seat (NetSapiens bound your user to the sign-in, and the
// platform verifies that by signature), so from here you can add your other
// email addresses or your chat account, each confirmed with a one-time code
// sent to it, and the same decision then applies there too.

const SCHEME: Record<string, string> = {
  ns_uid: 'Your seat', sip: 'Phone / device', tel: 'Phone number', mailto: 'Email',
  matrix: 'Chat', wa_jid: 'WhatsApp', fb: 'Messenger', gchat: 'Google Chat',
};
const PROOF: Record<string, string> = {
  horizon_signin: 'confirmed by your sign-in', email_code: 'confirmed by email code',
  matrix_code: 'confirmed by chat code',
};

export const MyAddresses: React.FC<{ host: Partial<HorizonProps> }> = ({ host }) => {
  const [me, setMe] = useState<MyIdentity | null>(null);
  const [address, setAddress] = useState('');
  const [challenge, setChallenge] = useState<{ id: string; masked: string; channel: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    siprec.identity(host).then(setMe).catch(e => setError(e?.message || 'Could not load your addresses.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dark = host.theme === 'dark';
  const card: React.CSSProperties = {
    border: `1px solid ${dark ? '#3a3c44' : '#E1E2EA'}`, borderRadius: 10, padding: '16px 18px',
    marginBottom: 16, background: dark ? '#1b1c22' : '#ffffff', maxWidth: 720,
  };
  const button: React.CSSProperties = {
    fontSize: 13, padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
    border: `1px solid ${dark ? '#5a5c66' : '#bcbfc7'}`, background: dark ? '#2a2b31' : '#ffffff',
    color: dark ? '#e8e8ea' : '#1E2130',
  };
  const primary: React.CSSProperties = { ...button, background: '#2A3060', color: '#fff', border: '1px solid #2A3060' };
  const input: React.CSSProperties = {
    fontSize: 13, padding: '6px 8px', borderRadius: 6, border: `1px solid ${dark ? '#5a5c66' : '#bcbfc7'}`,
    background: dark ? '#121318' : '#fff', color: dark ? '#e8e8ea' : '#1E2130',
  };

  if (!me) return error ? <div style={card}><span style={{ color: '#A63D40' }}>{error}</span></div> : null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e: any) { setError(e?.message || 'That did not work; please try again.'); }
    setBusy(false);
  };
  const anyChannel = me.channels.email || me.channels.matrix;

  return (
    <div style={card}>
      <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>My addresses</h3>
      <p style={{ margin: '0 0 10px', opacity: 0.8, fontSize: 14 }}>
        Your consent covers every address listed here. Add the other ways you talk to us so the
        same decision applies there too.
      </p>
      {me.identifiers.map(i => (
        <div key={i.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '4px 0', fontSize: 14 }}>
          <span style={{ minWidth: 120, opacity: 0.75 }}>{SCHEME[i.scheme] || i.scheme}</span>
          <span style={{ fontFamily: 'monospace' }}>{i.value}</span>
          <span style={{ opacity: 0.7, fontSize: 12 }}>
            {i.proven ? (PROOF[i.proof || ''] || 'confirmed') : 'seen on your calls'}
          </span>
          {i.id !== me.anchor_id && ['mailto', 'matrix'].includes(i.scheme) && i.proven && (
            <button type="button" style={button} disabled={busy}
              onClick={() => run(async () => setMe(await siprec.identityUnlink(host, i.id)))}>
              Remove
            </button>
          )}
        </div>
      ))}

      {!anyChannel ? (
        <p style={{ margin: '10px 0 0', opacity: 0.7, fontSize: 13 }}>Adding addresses is not available yet.</p>
      ) : !challenge ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <input style={{ ...input, minWidth: 260 }} value={address} disabled={busy}
            onChange={e => setAddress(e.target.value)}
            placeholder={me.channels.matrix ? 'name@example.com or @you:matrix.12by9.com' : 'name@example.com'} />
          <button type="button" style={primary} disabled={busy || !address.trim()}
            onClick={() => run(async () => {
              const r = await siprec.identityStart(host, address.trim());
              setChallenge({ id: r.challenge_id, masked: r.masked, channel: r.channel });
              setCode('');
            })}>
            {busy ? 'Sending…' : 'Send me a code'}
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 12, fontSize: 14 }}>
          We sent a 6-digit code {challenge.channel === 'email' ? 'by email' : 'as a chat message'} to{' '}
          <span style={{ fontFamily: 'monospace' }}>{challenge.masked}</span>. It expires in 15 minutes.
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <input style={{ ...input, width: 110 }} inputMode="numeric" autoComplete="one-time-code"
              value={code} disabled={busy} onChange={e => setCode(e.target.value)} placeholder="123456" />
            <button type="button" style={primary} disabled={busy || code.trim().length < 6}
              onClick={() => run(async () => {
                setMe(await siprec.identityVerify(host, challenge.id, code.trim()));
                setChallenge(null); setAddress(''); setCode('');
              })}>
              Confirm
            </button>
            <button type="button" style={button} disabled={busy} onClick={() => setChallenge(null)}>Cancel</button>
          </div>
        </div>
      )}
      {error && <div style={{ color: '#A63D40', marginTop: 8, fontSize: 13 }}>{error}</div>}
    </div>
  );
};
