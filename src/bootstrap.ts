// Entry point for the federated build.
//
// ModuleFederationPlugin needs an entry, but this remote has no standalone
// page of its own — everything it offers is reached through the exposed
// ./App, which Horizon mounts. Keeping the entry empty avoids pulling React
// into the initial chunk and keeps remoteEntry.js small.
export {};
