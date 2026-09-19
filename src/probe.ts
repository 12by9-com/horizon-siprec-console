import { SIPREC_API, currentApiBase } from './api';
import { groupDiagnostics, probeRecordings } from './callGroups';
import { callIdDiagnostics, probeCallIdLookup } from './cdrCallIds';
import { hostProps } from './host';
import { consentDiagnostics, probeUserConsent } from './userConsent';

// A console handle for an app that has no console of its own.
//
// Everything this bundle does inside Horizon happens on a page it does not own:
// the row buttons draw into the host's table, and when a lookup behind them
// fails the only correct behaviour is to draw nothing. That is indistinguishable
// from "the feature never loaded", and it is exactly what cost a round of
// guesswork the first time it happened.
//
// So the state is reachable:
//
//   __siprecConsole__.state()      what is registered, and what the two
//                                  lookups have asked and been told
//   await __siprecConsole__.probeCdrs()      re-run the host CDR lookup
//   await __siprecConsole__.probeRecordings("<call-id>")   ask the platform
//   await __siprecConsole__.probeConsent("<user@domain>")  ask the platform
//
// Read-only, and nothing here is on the path the buttons take.
// Where the same-origin prefix actually resolves on the page we are running
// on. The prefix alone no longer answers "which platform am I talking to?" —
// it is deliberately instance-independent, and the portal's proxy decides the
// far end. Reporting both says what the app asked for AND which portal was
// asked, which is the pair a misrouted proxy shows up in.
function apiUrl(): string {
  const base = currentApiBase();
  try {
    return new URL(base, window.location.origin).href;
  } catch {
    return base;
  }
}

export function installProbe(
  registered: string[], version: string, builtAt = '',
): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).__siprecConsole__ = {
    version,
    builtAt,
    api: SIPREC_API,
    apiResolved: apiUrl(),
    registered,
    state: () => ({
      version,
      builtAt,
      api: SIPREC_API,
      apiResolved: apiUrl(),
      registered,
      host: {
        hasApi: !!hostProps.api?.get,
        hasEventBus: !!hostProps.eventBus,
        user: hostProps.user?.extension ?? null,
        domain: hostProps.user?.domain ?? null,
        scope: hostProps.user?.scope ?? null,
      },
      callIds: callIdDiagnostics(),
      recordings: groupDiagnostics(),
      consent: consentDiagnostics(),
    }),
    probeCdrs: () => probeCallIdLookup(),
    probeRecordings: (groupId: string) => probeRecordings(hostProps, groupId),
    probeConsent: (partyUid: string) => probeUserConsent(hostProps, partyUid),
  };
}
