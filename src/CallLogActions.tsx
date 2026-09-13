import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CallRecording, siprec } from './api';
import { useCallRecordings } from './callGroups';
import { useRowCallId } from './cdrCallIds';
import { HorizonExtensionProps, HorizonProps } from './horizon';
import { hostProps } from './host';
import { RowIconButton } from './RowIconButton';
import { VconModal } from './VconModal';

// Play and vCon buttons on the rows of Horizon's OWN Call Logs table.
//
// Registered into the host's `table-row-actions` zone, which its shared
// DataTable renders at the end of every row's action column — so these appear
// beside Horizon's native row actions, on a page this app does not own and did
// not build.
//
// The bridge between the two systems is the SIP Call-ID. A call log row is a
// SIP session whose orig_callid the SBC copied into the group id of the SIPREC
// metadata, which the recorder stored on the recording session. That is the
// join, and it is the only one — a vCon carries no CDR id and a CDR carries no
// vCon uuid.
//
// The row does not carry that Call-ID, though, and getting it is a lookup of
// its own: see ./cdrCallIds, which resolves a page of rows in one request.
//
// One row can front SEVERAL recordings. A transfer ends one recording and
// starts the next under the same group id with the following group_seq, so a
// single call log line can have two, three or five vCons behind it. With one,
// the button does the thing; with more, it opens the list and lets the reader
// choose. Nothing here decides WHICH recordings exist: the platform answers
// that under the caller's own role, so a row whose call was recorded for
// someone else simply has no buttons.

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// A recording still running, or one that ended without a BYE, has no duration
// — which is a fact about the call worth showing as a dash rather than 0:00.
function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

// The recordings behind one call log row.
//
// Always a list, even of one, because the list is the answer to "what is behind
// this line" — when, how long, who was on it. The button that was pressed
// decides only what happens first: Play starts the single recording it found,
// and vCon on a single recording never gets here at all (the caller opens the
// document directly).
const CallRecordingsPopup: React.FC<{
  host: Partial<HorizonProps>;
  recordings: CallRecording[];
  autoPlayUuid: string | null;
  dark: boolean;
  onClose: () => void;
}> = ({ host, recordings, autoPlayUuid, dark, onClose }) => {
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [playingUuid, setPlayingUuid] = useState<string | null>(null);
  const [loadingUuid, setLoadingUuid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vconUuid, setVconUuid] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The blob URL currently held, so cleanup on unmount revokes the right one
  // without making every play a dependency of the effect that revokes it.
  const heldRef = useRef<string | null>(null);

  const play = React.useCallback(async (uuid: string) => {
    setLoadingUuid(uuid);
    setError(null);
    try {
      const url = await siprec.audioUrl(host, uuid);
      if (heldRef.current) URL.revokeObjectURL(heldRef.current);
      heldRef.current = url;
      setAudioSrc(url);
      setPlayingUuid(uuid);
    } catch (e: any) {
      setError(e?.message || 'Playback failed');
    } finally {
      setLoadingUuid(null);
    }
  }, [host]);

  // Pressing Play on a call with one recording should play it, not ask which.
  useEffect(() => {
    if (autoPlayUuid) void play(autoPlayUuid);
  }, [autoPlayUuid, play]);

  useEffect(() => () => {
    if (heldRef.current) URL.revokeObjectURL(heldRef.current);
  }, []);

  // Escape closes, and focus moves into the panel so a keyboard user is not
  // left tabbing through the table behind the overlay. Escape is ignored while
  // the vCon document is open on top — that modal owns the key then.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !vconUuid) onClose();
    };
    document.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => { document.removeEventListener('keydown', onKey); };
  }, [onClose, vconUuid]);

  // The page behind the overlay is stopped from scrolling for as long as this
  // panel exists, and for no longer.
  //
  // Its own effect, with NO dependencies, because a nested modal opens on top
  // of this one. Locking from the Escape effect above meant re-running it
  // whenever vconUuid changed — and a re-run restores the body, re-reads it, and
  // saves whatever the CHILD modal had already set. Closing both then put
  // `overflow: hidden` back and left the host page unscrollable, with no
  // overlay on screen to explain why.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);


  const surface = dark ? '#1c1f2b' : '#ffffff';
  const ink = dark ? '#e8e8ea' : '#1E2130';
  const hairline = '1px solid rgba(128,128,128,0.28)';
  const button: React.CSSProperties = {
    appearance: 'none', border: hairline, borderRadius: 6,
    background: dark ? '#262a38' : '#f5f5f7', color: ink,
    cursor: 'pointer', fontSize: 13, padding: '5px 11px', lineHeight: 1.4,
    whiteSpace: 'nowrap',
  };

  const many = recordings.length > 1;

  return createPortal(
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 2147483000,
        background: 'rgba(0,0,0,0.45)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={many ? 'Recordings of this call' : 'Recording of this call'}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{
          background: surface, color: ink, borderRadius: 10, border: hairline,
          width: 'min(720px, 100%)', maxHeight: '80vh', overflow: 'auto',
          padding: 20, fontFamily: 'system-ui, -apple-system, sans-serif',
          boxShadow: '0 12px 40px rgba(0,0,0,0.35)', outline: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>
            {many ? `${recordings.length} recordings of this call` : 'Recording of this call'}
          </h3>
          <button type="button" onClick={onClose} style={{ ...button, marginLeft: 'auto' }}>
            Close
          </button>
        </div>
        {many && (
          <p style={{ opacity: 0.7, fontSize: 13, margin: '0 0 12px' }}>
            One SIP session, recorded in segments — a transfer ends one and starts
            the next, so each is a separate conversation record.
          </p>
        )}

        {error && (
          <div style={{ color: '#A63D40', fontSize: 13, marginBottom: 10 }}>{error}</div>
        )}

        {recordings.map((r, i) => (
          <div
            key={r.uuid}
            style={{
              borderTop: i === 0 ? 'none' : hairline,
              padding: '12px 0',
              display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap',
            }}
          >
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {many ? `Segment ${i + 1} of ${recordings.length}` : formatWhen(r.created_at)}
                {many && (
                  <span style={{ fontWeight: 400, opacity: 0.7 }}>
                    {' · '}{formatWhen(r.created_at)}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
                {formatDuration(r.duration_ms)} · {formatBytes(r.size_bytes)}
                {r.has_transcript ? ' · transcribed' : ''}
              </div>
              <div style={{ fontSize: 12, marginTop: 6 }}>
                {r.parties.length === 0 ? (
                  <span style={{ opacity: 0.6 }}>No parties recorded</span>
                ) : r.parties.map((p, n) => (
                  <div key={n} style={{ fontWeight: p.is_you ? 600 : 400 }}>
                    {p.name || p.uid || p.tel || '—'}{p.is_you ? ' (you)' : ''}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => void play(r.uuid)}
                disabled={loadingUuid === r.uuid}
                style={{ ...button, opacity: loadingUuid === r.uuid ? 0.5 : 1 }}
              >
                {loadingUuid === r.uuid ? 'Loading…' : '▶  Play'}
              </button>
              <button type="button" onClick={() => setVconUuid(r.uuid)} style={button}>
                vCon
              </button>
            </div>
            {playingUuid === r.uuid && audioSrc && (
              <div style={{ flexBasis: '100%' }}>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio src={audioSrc} controls autoPlay style={{ width: '100%' }} />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* On top of this list rather than instead of it, so closing the document
          returns to the segment it came from. */}
      {vconUuid && (
        <VconModal host={host} uuid={vconUuid} dark={dark} onClose={() => setVconUuid(null)} />
      )}
    </div>,
    document.body,
  );
};

// Shared by both buttons: the row's Call-ID, the recordings behind it, and the
// popup state. Two lookups in sequence — the host for the Call-ID, then the
// platform for what was recorded under it — each batched across the whole
// visible page, so a screen of rows costs two requests rather than two per row.
//
// Hooks run unconditionally. The decision not to render happens after them,
// never by skipping one, and `useCallRecordings(null)` is the shape that lets
// the second lookup wait for the first without a conditional hook.
function useRowRecordings(context: HorizonExtensionProps['context']) {
  const row = (context?.pageContext as { row?: unknown } | undefined)?.row;
  const { state: callIdState, callId } =
    useRowCallId(context, row && typeof row === 'object' ? row as Record<string, unknown> : null);
  const answer = useCallRecordings(hostProps, callId);
  return {
    ...answer,
    groupId: callId,
    // Still resolving the Call-ID is 'loading' too: a row is not known to have
    // no recording until both halves have answered.
    state: callIdState === 'ready' ? answer.state : callIdState,
  };
}

// The vCon document behind this call log row.
//
// With one recording it opens the document directly: the list would be a list
// of one, and the reader asked for the document. With several it opens the
// list, because "which of these five" is a question only the reader can answer.
export const CallLogVconButton: React.FC<HorizonExtensionProps> = ({ context }) => {
  const { recordings, state } = useRowRecordings(context);
  const [open, setOpen] = useState(false);
  const dark = context?.theme === 'dark';

  if (state !== 'ready' || recordings.length === 0) return null;

  const single = recordings.length === 1 ? recordings[0] : null;
  return (
    <>
      <RowIconButton
        ui={context?.ui}
        icon="mdi:file-document-outline"
        glyph="{ }"
        label={single
          ? 'View the vCon for this call'
          : `View the vCons for this call (${recordings.length} segments)`}
        dark={dark}
        onClick={() => setOpen(true)}
      />
      {open && single && (
        <VconModal host={hostProps} uuid={single.uuid} dark={dark}
          onClose={() => setOpen(false)} />
      )}
      {open && !single && (
        <CallRecordingsPopup host={hostProps} recordings={recordings}
          autoPlayUuid={null} dark={dark} onClose={() => setOpen(false)} />
      )}
    </>
  );
};

// Play the recording of this call log row.
//
// Absent when the platform says this role may not listen — which is its own
// permission, separate from being able to see that a recording exists.
export const CallLogPlayButton: React.FC<HorizonExtensionProps> = ({ context }) => {
  const { recordings, state, canPlay } = useRowRecordings(context);
  const [open, setOpen] = useState(false);
  const dark = context?.theme === 'dark';

  if (state !== 'ready' || recordings.length === 0 || !canPlay) return null;

  const single = recordings.length === 1 ? recordings[0] : null;
  return (
    <>
      <RowIconButton
        ui={context?.ui}
        icon="mdi:play-circle-outline"
        glyph="▶"
        label={single
          ? 'Play the recording of this call'
          : `Play the recordings of this call (${recordings.length} segments)`}
        dark={dark}
        onClick={() => setOpen(true)}
      />
      {open && (
        <CallRecordingsPopup host={hostProps} recordings={recordings}
          autoPlayUuid={single ? single.uuid : null} dark={dark}
          onClose={() => setOpen(false)} />
      )}
    </>
  );
};
