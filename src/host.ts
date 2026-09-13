import { hostUid } from './api';
import { HorizonProps } from './horizon';

// The host props, parked where code outside the App tree can read them.
//
// The registered component is rendered by the host router, and the row-action
// buttons are rendered inside Horizon's OWN Call Logs table — both outside this
// module's React tree, so neither can receive props through JSX. App parks what
// the host passes here on every render, and the pages and extensions read it.
//
// Mutated in place, never reassigned: the pages take this as a prop and key
// their load effects on it, so a fresh object each render would refetch the
// recordings list every time the host re-renders or a tab changes.
export const hostProps: Partial<HorizonProps> = {};

export function parkHostProps(props: Partial<HorizonProps>): void {
  Object.assign(hostProps, props);
}

// Who the caches in this bundle belong to.
//
// Horizon persists remote-auth tokens under a key with no user in it and does
// not clear them on sign-out, so the API layer re-mints when the signed-in
// person changes. Anything cached from before that point is the previous
// person's answer, and every cache here clears on the same signal. Scope is
// part of it as well: a role change has to re-ask, or a cache would keep
// serving what the old role could see.
export function identityNamespaceFor(host: Partial<HorizonProps>): string {
  return `${hostUid(host) ?? 'unknown'}|${host.user?.scope ?? ''}`;
}
