import React, { useEffect, useState, useCallback } from 'react';
import { HorizonProps } from './horizon';
import { siprec, ScopePolicy, Visibility, Identity } from './api';

// Super-User-only editor for what every OTHER role may see.
//
// The defaults shipped with the schema are a starting position, not a policy:
// an operator may decide their Call Center Supervisors should not hear audio,
// or that Resellers get their whole territory's consent. This is where that is
// changed, without a deploy.
//
// The route is registered for everyone; the server is the gate. A user whose
// role is not platform-wide gets 403 here, and this page shows that plainly
// rather than pretending the controls exist.

const VIS_HELP: Record<Visibility, string> = {
  none: 'Nothing at all',
  own: 'Only their own records',
  domain: 'Everyone in their own domain',
  territory: 'Every domain in their territory',
  all: 'The entire platform',
};

const cell: React.CSSProperties = { padding: '8px 10px', verticalAlign: 'middle' };

export const AccessAdmin: React.FC<{ host: Partial<HorizonProps> }> = ({ host }) => {
  const [scopes, setScopes] = useState<ScopePolicy[]>([]);
  const [visibilities, setVisibilities] = useState<Visibility[]>([]);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await siprec.scopeAccess(host);
      setScopes(data.scopes);
      setVisibilities(data.visibilities);
      setIdentity((data as any).identity ?? null);
      setForbidden(false);
    } catch (e: any) {
      const msg = e.message || 'Could not load access policy';
      setForbidden(/platform-wide|403/i.test(msg));
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [host]);

  useEffect(() => { load(); }, [load]);

  const update = async (scope: string, patch: Partial<ScopePolicy>) => {
    setBusy(scope);
    setError(null);
    setNotice(null);
    // Optimistic: the row is small and the server returns the authoritative
    // copy, which replaces this on success.
    const before = scopes;
    setScopes(prev => prev.map(s => s.scope === scope ? { ...s, ...patch } : s));
    try {
      const res: any = await siprec.setScopeAccess(host, { scope, ...patch });
      if (res?.scope) {
        setScopes(prev => prev.map(s => s.scope === scope ? { ...s, ...res.scope } : s));
      }
      setNotice(`Updated ${scope}. Takes effect on their next page load.`);
    } catch (e: any) {
      setScopes(before);
      setError(e.message || 'Could not update access policy');
    } finally {
      setBusy(null);
    }
  };

  const dark = host.theme === 'dark';

  if (forbidden) {
    return (
      <div style={{ padding: 24, color: dark ? '#e8e8ea' : '#1E2130', fontFamily: 'system-ui, sans-serif' }}>
        <h2 style={{ marginTop: 0 }}>Access</h2>
        <div style={{ background: '#F6E7E7', border: '1px solid #e0b9b9', padding: 12, borderRadius: 6, maxWidth: 640 }}>
          Adjusting access policy is limited to platform-wide roles. Your role{' '}
          {identity?.scope ? <b>{identity.scope}</b> : null} cannot view or change it.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, color: dark ? '#e8e8ea' : '#1E2130', fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ marginTop: 0 }}>Access</h2>
      <p style={{ opacity: 0.7, marginTop: -8, maxWidth: 760 }}>
        What each role may see on the Recordings and Consent pages. These are the
        platform&rsquo;s own rules — a role&rsquo;s reach here is always further
        limited by their own domain or territory, so granting a role{' '}
        <i>domain</i> does not let them see other domains.
      </p>

      {error && !forbidden && <div style={{ color: '#A63D40', marginBottom: 10 }}>{error}</div>}
      {notice && <div style={{ color: '#2A3060', marginBottom: 10 }}>{notice}</div>}

      {loading ? <div>Loading…</div> : (
        <table style={{ borderCollapse: 'collapse', fontSize: 14, minWidth: 720 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid rgba(128,128,128,0.3)' }}>
              <th style={cell}>Role</th>
              <th style={cell}>Recordings</th>
              <th style={cell}>Consent</th>
              <th style={cell}>Play audio</th>
              <th style={cell} title="Start transcription on demand. Unlike the others this is not a read: it spends money at Google, rewrites the stored vCon and appends to its lifecycle ledger.">Transcribe</th>
              <th style={cell}>Change consent</th>
              <th style={cell}>Last change</th>
            </tr>
          </thead>
          <tbody>
            {scopes.map(s => {
              const isSelf = identity?.scope === s.scope;
              return (
                <tr key={s.scope}
                    style={{ borderBottom: '1px solid rgba(128,128,128,0.15)',
                             background: isSelf ? 'rgba(200,134,47,0.08)' : undefined }}>
                  <td style={cell}>
                    {s.scope}{isSelf ? <span style={{ opacity: 0.6 }}> (you)</span> : null}
                  </td>
                  {(['recordings_visibility', 'consent_visibility'] as const).map(col => (
                    <td key={col} style={cell}>
                      <select value={s[col]} disabled={busy === s.scope}
                        onChange={e => update(s.scope, { [col]: e.target.value } as Partial<ScopePolicy>)}
                        title={VIS_HELP[s[col]]}>
                        {visibilities.map(v => (
                          <option key={v} value={v} title={VIS_HELP[v]}>{v}</option>
                        ))}
                      </select>
                    </td>
                  ))}
                  {(['can_play_audio', 'can_transcribe', 'can_modify_consent'] as const).map(col => (
                    <td key={col} style={cell}>
                      <input type="checkbox" checked={s[col]} disabled={busy === s.scope}
                        onChange={e => update(s.scope, { [col]: e.target.checked })} />
                    </td>
                  ))}
                  <td style={{ ...cell, fontSize: 12, opacity: 0.7 }}>
                    {s.updated_at
                      ? `${new Date(s.updated_at).toLocaleString()}${s.updated_by ? ` by ${s.updated_by}` : ''}`
                      : 'default'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p style={{ opacity: 0.6, fontSize: 12, marginTop: 16, maxWidth: 760 }}>
        Your own role is shown but cannot be reduced below platform-wide — doing so
        would remove your access to this page with no way back short of the database.
      </p>
    </div>
  );
};
