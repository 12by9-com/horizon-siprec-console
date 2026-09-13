import React, { useEffect, useState, useCallback } from 'react';
import { HorizonProps } from './horizon';
import { VconModal } from './VconModal';
import {
  siprec, Recording, AccessInfo, Identity, Transcript, TranscriptStatus,
  scopedTitle, visibilityLabel,
} from './api';

// Recordings the signed-in user is entitled to see.
//
// The title changes with the role — "My Recordings" for someone who can see
// only themselves, plain "Recordings" for a manager looking at a domain — so
// whose data is on screen is never ambiguous.
//
// Nothing here decides what is visible. The list arrives already scoped by the
// platform; this only renders it.

const cell: React.CSSProperties = { padding: '8px 10px', verticalAlign: 'top' };

// A recording with no transcript still owes the reader an explanation, but a
// table cell is the wrong place for a sentence — so the cell carries the short
// form and the full note is the tooltip.
const SHORT_STATUS: Record<string, string> = {
  pending: 'Queued',
  no_consent: 'No consent',
  no_audio: 'No audio',
  empty: 'No speech',
  failed: 'Failed',
};

function shortStatus(status: TranscriptStatus): string {
  return status ? (SHORT_STATUS[status] ?? status) : 'Not transcribed';
}

// Recognition confidence, shown as a percentage. Telephony audio is 8 kHz and
// scores accordingly; a reader who cannot see the score has no way to tell a
// quotation from a guess.
function confidenceLabel(c?: number | null): string | null {
  return typeof c === 'number' ? `${Math.round(c * 100)}% confidence` : null;
}

// What was said, once a row is expanded.
//
// Only segments carrying text are rendered: a vCon's dialog also holds the
// audio entry itself, which the API reports as present-but-omitted, and
// listing "(audio)" above the words it was turned into helps nobody reading.
const TranscriptPanel: React.FC<{
  dark: boolean;
  loading: boolean;
  error?: string;
  transcript?: Transcript;
}> = ({ dark, loading, error, transcript }) => {
  const box: React.CSSProperties = {
    background: dark ? '#1b1c22' : '#f4f5f8',
    borderRadius: 8,
    padding: 12,
  };

  if (loading) return <div style={box}>Loading transcript…</div>;
  if (error) return <div style={{ ...box, color: '#A63D40' }}>{error}</div>;
  if (!transcript) return null;

  const spoken = transcript.segments.filter(s => (s.text ?? '').trim() !== '');
  const meta = [
    transcript.engine,
    transcript.model,
    transcript.language,
    confidenceLabel(transcript.confidence),
  ].filter(Boolean).join(' · ');

  return (
    <div style={box}>
      {meta && (
        <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 8 }}>
          Machine transcript — {meta}
        </div>
      )}
      {spoken.length === 0 ? (
        <div style={{ opacity: 0.7 }}>
          {transcript.note ?? 'This recording carries no readable text.'}
        </div>
      ) : spoken.map(s => (
        <div key={s.index} style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
          <div style={{ minWidth: 130, fontWeight: 600, fontSize: 13 }}>
            {s.speaker ?? '—'}
            {confidenceLabel(s.generated_by?.confidence) && (
              <div style={{ fontWeight: 400, fontSize: 11, opacity: 0.6 }}>
                {confidenceLabel(s.generated_by?.confidence)}
              </div>
            )}
          </div>
          <div style={{ whiteSpace: 'pre-wrap', flex: 1 }}>{s.text}</div>
        </div>
      ))}
    </div>
  );
};

export const RecordingsPage: React.FC<{ host: Partial<HorizonProps> }> = ({ host }) => {
  const [rows, setRows] = useState<Recording[]>([]);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [access, setAccess] = useState<AccessInfo | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  // Which row is expanded, and the transcripts already fetched. Cached by uuid
  // so collapsing and reopening a row costs nothing.
  const [openUuid, setOpenUuid] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Record<string, Transcript>>({});
  const [loadingUuid, setLoadingUuid] = useState<string | null>(null);
  const [transcriptError, setTranscriptError] = useState<Record<string, string>>({});
  // Which row's vCon document is open, if any. A modal rather than an expanded
  // row: it is the whole record, not a detail of the row.
  const [vconUuid, setVconUuid] = useState<string | null>(null);
  // A transcription run is a network round trip measured in seconds, so the
  // row has to say it is working rather than appear to have ignored the click.
  const [transcribing, setTranscribing] = useState<string | null>(null);
  const [transcribeNote, setTranscribeNote] = useState<Record<string, string>>({});

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await siprec.recordings(host, q);
      setRows(data.recordings);
      setIdentity(data.identity);
      setAccess(data.access);
    } catch (e: any) {
      setError(e.message || 'Could not load recordings');
    } finally {
      setLoading(false);
    }
  }, [host]);

  useEffect(() => { load(''); }, [load]);

  // A blob URL outlives the component unless revoked.
  useEffect(() => () => { if (audioSrc) URL.revokeObjectURL(audioSrc); }, [audioSrc]);

  const play = async (uuid: string) => {
    try {
      if (audioSrc) URL.revokeObjectURL(audioSrc);
      const url = await siprec.audioUrl(host, uuid);
      setAudioSrc(url);
      setPlaying(uuid);
    } catch (e: any) {
      setError(e.message || 'Playback failed');
    }
  };

  const toggleTranscript = async (uuid: string) => {
    if (openUuid === uuid) {
      setOpenUuid(null);
      return;
    }
    setOpenUuid(uuid);
    if (transcripts[uuid]) {
      return;   // already fetched
    }
    setLoadingUuid(uuid);
    setTranscriptError(prev => { const { [uuid]: _drop, ...rest } = prev; return rest; });
    try {
      const t = await siprec.transcript(host, uuid);
      setTranscripts(prev => ({ ...prev, [uuid]: t }));
    } catch (e: any) {
      setTranscriptError(prev => ({ ...prev, [uuid]: e.message || 'Could not load the transcript' }));
    } finally {
      setLoadingUuid(null);
    }
  };

  // Transcribe on demand. The outcome is not simply success or failure: a run
  // can legitimately end 'no_consent' or 'empty', and those carry the sentence
  // that explains them — which is the whole reason someone pressed the button.
  const transcribe = async (uuid: string) => {
    setTranscribing(uuid);
    setTranscribeNote(prev => { const { [uuid]: _drop, ...rest } = prev; return rest; });
    try {
      const r = await siprec.transcribe(host, uuid);
      const note = r.status === 'done'
        ? `Transcribed — ${r.segments ?? 0} segment(s), ${r.chars ?? 0} characters`
          + (r.ledgered === false ? '. WARNING: the lifecycle ledger entry could not be written.' : '')
        : (r.message || r.error || `Finished with status ${r.status}`);
      setTranscribeNote(prev => ({ ...prev, [uuid]: note }));
      // Reload so the row's status label and Transcript button reflect it.
      await load(search);
    } catch (e: any) {
      setTranscribeNote(prev => ({ ...prev, [uuid]: e.message || 'Transcription failed' }));
    } finally {
      setTranscribing(null);
    }
  };

  const dark = host.theme === 'dark';
  const title = scopedTitle('Recordings', access?.visibility);

  // Horizon's stylesheet flattens a bare <button> inside an app — it loses its
  // chrome and reads as static text. With one action per row that merely looked
  // plain; with two side by side it actively misled, because "Play" and
  // "Transcript" ran together as a single phrase "Play Transcript". So each
  // control carries its own affordance, and the two are deliberately unalike:
  // Play leads with ▶, Transcript trails with a disclosure caret and an accent
  // colour, because one starts audio and the other expands the row.
  const button: React.CSSProperties = {
    fontSize: 13, padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
    border: `1px solid ${dark ? '#5a5c66' : '#bcbfc7'}`,
    background: dark ? '#2a2b31' : '#ffffff',
    color: dark ? '#e8e8ea' : '#1E2130',
    fontFamily: 'inherit', whiteSpace: 'nowrap',
  };
  const disclosure: React.CSSProperties = {
    ...button, color: dark ? '#9ec1ff' : '#1a5fb4',
  };
  // Not an action, and must not look like one: no border, no background,
  // nothing to click. This is the row that used to read as "Play failed".
  const statusLabel: React.CSSProperties = {
    fontSize: 12, fontStyle: 'italic', opacity: 0.6,
    cursor: 'help', whiteSpace: 'nowrap',
  };

  return (
    <div style={{ padding: 24, color: dark ? '#e8e8ea' : '#1E2130', fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      {access && identity && (
        <p style={{ opacity: 0.7, marginTop: -8 }}>
          Showing {visibilityLabel(access.visibility, identity)} — your role is{' '}
          <b>{identity.scope}</b>.
          {access.requested_visibility === 'territory' && access.visibility === 'domain' && (
            <> Territory-wide access is configured but no territory is known for you, so this is
            limited to your domain.</>
          )}
        </p>
      )}
      {access?.unknown_scope && (
        <div style={{ background: '#F6E7E7', border: '1px solid #e0b9b9', padding: 10, borderRadius: 6, marginBottom: 12 }}>
          Your role <b>{identity?.scope}</b> has no access policy on the recording platform, so
          only your own records are shown. A Super User can add it under Access.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        <input value={search} onChange={e => setSearch(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') load(search); }}
          placeholder="Search by name, user ID or number"
          style={{ flex: 1, maxWidth: 380, padding: '6px 10px', borderRadius: 6, border: '1px solid #ccc' }} />
        <button onClick={() => load(search)} disabled={loading}
          style={{ ...button, opacity: loading ? 0.5 : 1 }}>Search</button>
        {search && (
          <button onClick={() => { setSearch(''); load(''); }} style={button}>Clear</button>
        )}
      </div>

      {error && <div style={{ color: '#A63D40', marginBottom: 10 }}>{error}</div>}
      {loading ? <div>Loading…</div> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid rgba(128,128,128,0.3)' }}>
              <th style={cell}>When</th>
              <th style={cell}>Parties</th>
              <th style={cell}>Size</th>
              <th style={cell} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td style={cell} colSpan={4}>No recordings visible to you.</td></tr>
            ) : rows.map(r => (
              <React.Fragment key={r.uuid}>
                <tr style={{ borderBottom: openUuid === r.uuid ? 'none' : '1px solid rgba(128,128,128,0.15)' }}>
                  <td style={cell}>{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</td>
                  <td style={cell}>
                    {r.parties.map((p, i) => (
                      <div key={i} style={{ fontWeight: p.is_you ? 600 : 400 }}>
                        {p.name || '—'}{p.is_you ? ' (you)' : ''}
                        <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, opacity: 0.65 }}>
                          {p.uid || p.tel}
                        </div>
                      </div>
                    ))}
                  </td>
                  <td style={cell}>{(r.size_bytes / 1048576).toFixed(1)} MB</td>
                  <td style={cell}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      {access?.can_play_audio !== false && (
                        <button onClick={() => play(r.uuid)}
                          disabled={playing === r.uuid && !!audioSrc}
                          style={{
                            ...button,
                            opacity: playing === r.uuid && !!audioSrc ? 0.5 : 1,
                          }}>
                          ▶&nbsp; Play
                        </button>
                      )}
                      {/* Reading is gated on the same permission as listening:
                          a transcript reveals what the audio reveals. */}
                      {access?.can_play_audio !== false && (r.has_transcript ? (
                        <button onClick={() => toggleTranscript(r.uuid)}
                          aria-expanded={openUuid === r.uuid} style={disclosure}>
                          Transcript &nbsp;{openUuid === r.uuid ? '▴' : '▾'}
                        </button>
                      ) : (
                        <>
                          <span title={r.transcript_note ?? undefined} style={statusLabel}>
                            {shortStatus(r.transcript_status)}
                          </span>
                          {/* Its own permission, because this one spends money
                              and rewrites the record — see can_transcribe. */}
                          {access?.can_transcribe && (
                            <button onClick={() => transcribe(r.uuid)}
                              disabled={transcribing !== null}
                              style={{ ...button, opacity: transcribing !== null ? 0.5 : 1 }}>
                              {transcribing === r.uuid ? 'Transcribing…' : 'Transcribe'}
                            </button>
                          )}
                        </>
                      ))}
                      {/* The document behind the row. Same permission as the
                          other two: it is a superset of what they show.
                          Neutral chrome, not the disclosure style — the caret
                          and accent colour mean "expands in place", and this
                          opens a dialog. */}
                      {access?.can_play_audio !== false && (
                        <button onClick={() => setVconUuid(r.uuid)} style={button}>
                          vCon
                        </button>
                      )}
                    </div>
                    {transcribeNote[r.uuid] && (
                      <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6, maxWidth: 380 }}>
                        {transcribeNote[r.uuid]}
                      </div>
                    )}
                  </td>
                </tr>
                {openUuid === r.uuid && (
                  <tr style={{ borderBottom: '1px solid rgba(128,128,128,0.15)' }}>
                    <td colSpan={4} style={{ padding: '0 10px 14px' }}>
                      <TranscriptPanel dark={dark} loading={loadingUuid === r.uuid}
                        error={transcriptError[r.uuid]} transcript={transcripts[r.uuid]} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}

      {vconUuid && (
        <VconModal host={host} uuid={vconUuid} dark={dark} onClose={() => setVconUuid(null)} />
      )}

      {audioSrc && (
        <div style={{ position: 'sticky', bottom: 0, marginTop: 16, padding: 10,
                      background: dark ? '#1b1c22' : '#f4f5f8', borderRadius: 8 }}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio src={audioSrc} controls autoPlay style={{ width: '100%' }} />
        </div>
      )}
    </div>
  );
};
