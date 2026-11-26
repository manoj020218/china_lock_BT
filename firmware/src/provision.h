// Wi-Fi bring-up, SoftAP setup mode and app-driven provisioning.
//
// Setup (SoftAP "JenixLock-XXXX", 192.168.4.1) is active when no Wi-Fi is
// configured, or when the configured network cannot be joined (then the
// station keeps retrying in the background, and the AP closes once it joins).
//
// Provisioning from the app: the phone joins the AP, POSTs the home Wi-Fi to
// /api/provision, and polls /api/provision/status. The gateway joins the home
// Wi-Fi in AP+STA mode (non-blocking) so the phone, still on the AP, can read
// the new LAN IP. Credentials are saved only after a successful join. The AP
// then closes (on /api/provision/finish or after a grace period).
#pragma once

#include <Arduino.h>

enum ProvState { PROV_IDLE, PROV_CONNECTING, PROV_CONNECTED, PROV_FAILED };

String deviceId();      // 12 hex chars of the Wi-Fi STA MAC, stable per gateway
String apSsid();        // "JenixLock-XXXX"
String mdnsHost();      // "jenixlock-xxxx" (unique per gateway; .local)

void wifiStart();       // (re)start Wi-Fi from the saved config
void wifiTick();        // call from loop(): provisioning + AP lifecycle

bool apActive();        // the setup SoftAP is up
// True when the gateway is factory-fresh (no Wi-Fi saved): only then may an
// unauthenticated client provision it and receive the API token.
bool openForSetup();

bool provisionBegin(const String& ssid, const String& pass);  // false if busy
void provisionFinish();                                       // close AP soon
ProvState provisionState();
const char* provisionStateName();
String provisionIp();
String provisionSsid();
String provisionError();
