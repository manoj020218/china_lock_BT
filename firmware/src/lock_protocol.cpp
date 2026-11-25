#include "lock_protocol.h"

#include "mbedtls/md5.h"

namespace lockproto {

uint16_t checksum16(const uint8_t* data, size_t len) {
  uint32_t sum = 0;
  for (size_t i = 0; i < len; i++) sum += data[i];
  return (uint16_t)(sum & 0xFFFF);
}

std::vector<uint8_t> encodeCommand(uint8_t command,
                                   const uint8_t* payload, size_t payloadLen,
                                   uint32_t address) {
  uint16_t length = (uint16_t)(payloadLen + 3);
  std::vector<uint8_t> checked;
  checked.push_back(FLAG_COMMAND);
  checked.push_back((length >> 8) & 0xFF);
  checked.push_back(length & 0xFF);
  checked.push_back(command);
  for (size_t i = 0; i < payloadLen; i++) checked.push_back(payload[i]);

  uint16_t cs = checksum16(checked.data(), checked.size());

  std::vector<uint8_t> frame;
  frame.push_back(PREAMBLE0);
  frame.push_back(PREAMBLE1);
  frame.push_back((address >> 24) & 0xFF);
  frame.push_back((address >> 16) & 0xFF);
  frame.push_back((address >> 8) & 0xFF);
  frame.push_back(address & 0xFF);
  frame.insert(frame.end(), checked.begin(), checked.end());
  frame.push_back((cs >> 8) & 0xFF);
  frame.push_back(cs & 0xFF);
  return frame;
}

bool completeFrameSize(const uint8_t* buf, size_t len, size_t& frameSize) {
  if (len < 9) return false;
  if (buf[0] != PREAMBLE0 || buf[1] != PREAMBLE1) return false;
  uint16_t declared = (buf[7] << 8) | buf[8];
  if (declared < 3) return false;
  size_t total = (size_t)declared + 9;
  if (len < total) return false;
  frameSize = total;
  return true;
}

bool decodeFrame(const uint8_t* data, size_t len, int requestCommand, Frame& out) {
  size_t size = 0;
  if (!completeFrameSize(data, len, size)) return false;

  uint8_t flag = data[6];
  if (flag != FLAG_COMMAND && flag != FLAG_ACK_WITH_COMMAND &&
      flag != FLAG_ACK_IMPLICIT_COMMAND) {
    return false;
  }
  uint16_t expected = (data[size - 2] << 8) | data[size - 1];
  uint16_t actual = checksum16(data + 6, size - 8);  // from flag..payload
  if (expected != actual) return false;

  out.address = ((uint32_t)data[2] << 24) | ((uint32_t)data[3] << 16) |
                ((uint32_t)data[4] << 8) | data[5];
  out.flag = flag;
  out.payload.clear();

  if (flag == FLAG_COMMAND) {
    out.command = data[9];
    out.error = -1;
    out.payload.assign(data + 10, data + size - 2);
  } else if (flag == FLAG_ACK_WITH_COMMAND) {
    out.command = data[9];
    out.error = data[10];
    out.payload.assign(data + 11, data + size - 2);
  } else {  // FLAG_ACK_IMPLICIT_COMMAND
    out.command = requestCommand;
    out.error = data[9];
    out.payload.assign(data + 10, data + size - 2);
  }
  return true;
}

String legacyLoginKey(const String& password, const String& lockId) {
  String input = password + lockId;
  uint8_t digest[16];
  mbedtls_md5((const unsigned char*)input.c_str(), input.length(), digest);

  // Uppercase hex of the digest, take characters 8..23 (16 hex chars = 8 bytes).
  static const char* H = "0123456789ABCDEF";
  char hex[33];
  for (int i = 0; i < 16; i++) {
    hex[i * 2] = H[digest[i] >> 4];
    hex[i * 2 + 1] = H[digest[i] & 0x0F];
  }
  hex[32] = 0;

  uint8_t token[8];
  for (int i = 0; i < 8; i++) {
    auto nib = [](char c) -> uint8_t {
      if (c >= '0' && c <= '9') return c - '0';
      return 10 + (c - 'A');
    };
    token[i] = (nib(hex[8 + i * 2]) << 4) | nib(hex[8 + i * 2 + 1]);
  }

  // Legacy v0: bytes[2..5] big-endian, masked 0x7FFFFFFF, as decimal ASCII.
  uint32_t value = ((uint32_t)token[2] << 24) | ((uint32_t)token[3] << 16) |
                   ((uint32_t)token[4] << 8) | token[5];
  value &= 0x7FFFFFFF;
  return String(value);
}

}  // namespace lockproto
