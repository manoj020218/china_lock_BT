// WS2812B status LED for on-site diagnosis (non-blocking state machine).
#pragma once

enum LedEventKind { LED_NONE = 0, LED_UNLOCK, LED_LOCK, LED_OK, LED_ERROR };

void ledSetup();
void ledTick();           // call frequently from loop(); non-blocking
void ledEvent(int kind);  // queue a transient command flash
