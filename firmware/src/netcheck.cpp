#include "netcheck.h"

#include <Arduino.h>
#include <WiFi.h>
#include <esp_netif.h>
#include <esp_netif_net_stack.h>
#include <lwip/etharp.h>
#include <lwip/tcpip.h>

static const uint32_t PROBE_EVERY_MS = 60000;
// Right after (re)joining Wi-Fi some routers keep a stale bridge entry for our
// MAC and black-hole traffic to us for minutes (seen: ~2 min after every
// reboot). Announcing ourselves often in that window makes them re-learn fast.
static const uint32_t FAST_WINDOW_MS = 120000;
static const uint32_t FAST_EVERY_MS = 10000;
static uint32_t s_joinedAt = 0;
static uint32_t s_lastFast = 0;
static bool s_wasUp = false;
static const uint32_t ANSWER_WAIT_MS = 2000;
static const int MISSES_RECONNECT = 3;
static const int MISSES_RESTART = 6;

static uint32_t s_lastProbe = 0;
static uint32_t s_probeSentAt = 0;
static bool s_waiting = false;
static int s_misses = 0;
static unsigned long s_recoveries = 0;

// Result of the in-stack check (written on the tcpip thread).
static volatile int s_found = -1;

int netcheckMisses() { return s_misses; }
unsigned long netcheckRecoveries() { return s_recoveries; }

static struct netif* staNetif() {
  esp_netif_t* h = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
  return h ? (struct netif*)esp_netif_get_netif_impl(h) : nullptr;
}

// lwIP is not thread-safe here (no core locking), so every ARP call runs on
// the tcpip thread via tcpip_callback().
static void cbAnnounceAndProbe(void*) {
  struct netif* n = staNetif();
  if (!n) return;
  etharp_gratuitous(n);
  ip4_addr_t gw;
  gw.addr = (uint32_t)WiFi.gatewayIP();
  etharp_request(n, &gw);
}

static void cbAnnounce(void*) {
  struct netif* n = staNetif();
  if (n) etharp_gratuitous(n);
}

static void cbCheck(void*) {
  struct netif* n = staNetif();
  if (!n) { s_found = 0; return; }
  ip4_addr_t gw;
  gw.addr = (uint32_t)WiFi.gatewayIP();
  struct eth_addr* mac = nullptr;
  const ip4_addr_t* ip = nullptr;
  s_found = etharp_find_addr(n, &gw, &mac, &ip) >= 0 ? 1 : 0;
}

static void cbFlush(void*) {
  struct netif* n = staNetif();
  if (n) etharp_cleanup_netif(n);
}

void netcheckTick() {
  // Only meaningful as a LAN station; the setup AP has its own lifecycle.
  if (!WiFi.isConnected() || (WiFi.getMode() & WIFI_AP)) {
    s_waiting = false;
    s_misses = 0;
    s_wasUp = false;
    return;
  }
  uint32_t now = millis();
  if (!s_wasUp) {  // just (re)joined
    s_wasUp = true;
    s_joinedAt = now;
    s_lastFast = 0;
  }
  if (now - s_joinedAt < FAST_WINDOW_MS && now - s_lastFast > FAST_EVERY_MS) {
    s_lastFast = now;
    tcpip_callback(cbAnnounce, nullptr);
  }

  if (s_waiting) {
    if (now - s_probeSentAt < ANSWER_WAIT_MS) return;
    s_waiting = false;
    s_found = -1;
    tcpip_callback(cbCheck, nullptr);
    uint32_t t0 = millis();
    while (s_found < 0 && millis() - t0 < 200) delay(5);
    if (s_found == 1) {
      if (s_misses) Serial.println(F("# netcheck: router reachable again"));
      s_misses = 0;
      return;
    }
    s_misses++;
    Serial.print(F("# netcheck: router did not answer ARP (miss "));
    Serial.print(s_misses);
    Serial.println(F(")"));
    if (s_misses == MISSES_RECONNECT) {
      Serial.println(F("# netcheck: reconnecting Wi-Fi"));
      s_recoveries++;
      WiFi.disconnect(false, false);
      delay(200);
      WiFi.reconnect();
    } else if (s_misses >= MISSES_RESTART) {
      Serial.println(F("# netcheck: still unreachable, restarting gateway"));
      delay(200);
      ESP.restart();
    }
    return;
  }

  if (now - s_lastProbe > PROBE_EVERY_MS) {
    s_lastProbe = now;
    // Flush the whole ARP table: stale peer entries (the "phone can't reach
    // the gateway" case) can't persist, and the router must answer afresh.
    tcpip_callback(cbFlush, nullptr);
    tcpip_callback(cbAnnounceAndProbe, nullptr);
    s_probeSentAt = now;
    s_waiting = true;
  }
}
