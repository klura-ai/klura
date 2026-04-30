// Tunnel abstraction: how a local TCP port is made reachable to a remote
// client. Each backend (cloudflared, local, direct) returns the same shape.

export interface Tunnel {
  url: string;
  kill: () => void;
}
