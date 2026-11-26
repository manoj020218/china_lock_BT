// Authenticated LAN REST API over Wi-Fi.
#pragma once

#include <Arduino.h>

void setupRestApi();
void handleRestApi();
// Gateway auto close (re-lock after an app/cloud unlock), see rest_api.cpp.
void autoCloseSchedule(const String& lockId, uint32_t user, const String& pin);
void autoCloseCancel(const String& lockId);
