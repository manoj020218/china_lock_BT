// Network self-check: keeps the gateway reachable on the LAN without a manual
// restart. Seen in the field: the phone could resolve the gateway but got no
// replies until the gateway was restarted (stale network state), while a wired
// PC still reached it.
//
// Every minute (station mode, Wi-Fi up):
//   - flush our ARP table so stale peer entries cannot persist;
//   - announce our address (gratuitous ARP) so phones/routers refresh caches;
//   - probe the router at layer 2 (ARP request + check the answer).
// For 2 minutes after every Wi-Fi join: announce every 10 s (routers that
// held a stale entry for our MAC re-learn it fast).
// Escalation if the router stops answering: 3 misses -> Wi-Fi reconnect,
// 6 misses -> restart (all configuration is in NVS).
#pragma once

void netcheckTick();          // call from loop()
int netcheckMisses();         // consecutive failed router probes
unsigned long netcheckRecoveries();  // Wi-Fi reconnects done by the self-check
