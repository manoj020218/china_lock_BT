// Optional cloud (MQTT) link: online/heartbeat handshake + command topic.
// The broker and cloud application are the client's responsibility; the gateway
// only connects, announces itself, heartbeats, and serves lock commands.
#pragma once

void cloudSetup();
void cloudLoop();
bool cloudConnected();
