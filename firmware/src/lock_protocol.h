// Ported lock protocol (framing, checksum, legacy login-key derivation).
// Mirrors client/protocol.py and tools/protocol_codec.py; validated values only.
#pragma once

#include <Arduino.h>
#include <vector>

namespace lockproto {

static const uint8_t PREAMBLE0 = 0xEF;
static const uint8_t PREAMBLE1 = 0x01;
static const uint32_t INITIAL_ADDRESS = 0xFFFFFFFF;

static const uint8_t FLAG_COMMAND = 0x01;
static const uint8_t FLAG_ACK_WITH_COMMAND = 0x05;
static const uint8_t FLAG_ACK_IMPLICIT_COMMAND = 0x07;

// Commands (validated subset)
enum Cmd : uint8_t {
  CMD_ADMIN_LOGIN = 0x13,
  CMD_GET_VERSION = 0x80,
  CMD_REBOOT = 0x81,
  CMD_LOCK_ACTION = 0x88,
  CMD_SET_TIME = 0x8A,
  CMD_GET_TIME = 0x8B,
  CMD_GET_BATTERY = 0x8C,
  CMD_GET_FREE_USER_ID = 0xA0,
  CMD_DELETE_USER = 0xA2,
  CMD_GET_USERS = 0xA3,
  CMD_RECORD_COUNT = 0xB2,
  CMD_RECORD_BATCH = 0xB3,
};

enum LockActionByte : uint8_t { ACTION_LOCK = 0x00, ACTION_UNLOCK = 0x01 };

struct Frame {
  uint32_t address = 0;
  uint8_t flag = 0;
  int command = -1;   // -1 = unknown
  int error = -1;     // -1 = none
  std::vector<uint8_t> payload;
};

uint16_t checksum16(const uint8_t* data, size_t len);

// Build a flag-1 command frame.
std::vector<uint8_t> encodeCommand(uint8_t command,
                                   const uint8_t* payload, size_t payloadLen,
                                   uint32_t address);

// If `buf` holds at least one complete frame starting at its first preamble,
// return its total size (>0) via `frameSize`; return false if incomplete.
bool completeFrameSize(const uint8_t* buf, size_t len, size_t& frameSize);

// Decode one complete frame. `requestCommand` attaches the command id to a
// flag-7 acknowledgement. Returns false on checksum/format error.
bool decodeFrame(const uint8_t* data, size_t len, int requestCommand, Frame& out);

// Legacy (command version 0) decimal-ASCII login key from password + lock id.
String legacyLoginKey(const String& password, const String& lockId);

}  // namespace lockproto
