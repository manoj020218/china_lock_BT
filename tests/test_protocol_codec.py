import unittest

from tools.protocol_codec import (
    FLAG_ACK_IMPLICIT_COMMAND,
    FLAG_ACK_WITH_COMMAND,
    FrameStreamDecoder,
    ProtocolError,
    checksum16,
    decode_frame,
    derive_credential_token,
    derive_login_key,
    encode_command,
)


def make_response(flag: int, body: bytes, address: int = 0x01020304) -> bytes:
    length = len(body) + 2
    checked = bytes((flag,)) + length.to_bytes(2, "big") + body
    return b"\xEF\x01" + address.to_bytes(4, "big") + checked + checksum16(checked).to_bytes(2, "big")


class ProtocolCodecTests(unittest.TestCase):
    def test_get_version_vector(self) -> None:
        encoded = encode_command(0x80)
        self.assertEqual(encoded.hex().upper(), "EF01FFFFFFFF010003800084")

        decoded = decode_frame(encoded)
        self.assertEqual(decoded.address, 0xFFFFFFFF)
        self.assertEqual(decoded.command, 0x80)
        self.assertIsNone(decoded.error_code)
        self.assertEqual(decoded.payload, b"")

    def test_flag_5_acknowledgement(self) -> None:
        encoded = make_response(FLAG_ACK_WITH_COMMAND, b"\x8C\x00\x64\x25")
        decoded = decode_frame(encoded)
        self.assertEqual(decoded.command, 0x8C)
        self.assertEqual(decoded.error_code, 0)
        self.assertEqual(decoded.payload, b"\x64\x25")

    def test_flag_7_uses_pending_command(self) -> None:
        encoded = make_response(FLAG_ACK_IMPLICIT_COMMAND, b"\x00\x01")
        decoded = decode_frame(encoded, request_command=0x80)
        self.assertEqual(decoded.command, 0x80)
        self.assertEqual(decoded.error_code, 0)
        self.assertEqual(decoded.payload, b"\x01")

    def test_fragment_reassembly(self) -> None:
        encoded = encode_command(0x8B, b"\x01\x02")
        decoder = FrameStreamDecoder()
        self.assertEqual(decoder.feed(b"noise" + encoded[:5]), [])
        frames = decoder.feed(encoded[5:])
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0].command, 0x8B)
        self.assertEqual(frames[0].payload, b"\x01\x02")

    def test_reassembly_preserves_split_preamble(self) -> None:
        encoded = encode_command(0x80)
        decoder = FrameStreamDecoder()
        self.assertEqual(decoder.feed(b"noise\xEF"), [])
        frames = decoder.feed(encoded[1:])
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0].command, 0x80)

    def test_bad_checksum_is_rejected(self) -> None:
        encoded = bytearray(encode_command(0x80))
        encoded[-1] ^= 0x01
        with self.assertRaises(ProtocolError):
            decode_frame(bytes(encoded))

    def test_credential_derivation_vectors(self) -> None:
        token = derive_credential_token("demo-pass", "LOCK-DEMO")
        self.assertEqual(token, "526765F9AACD7E60")
        self.assertEqual(derive_login_key(token, 0), "1710861005")
        self.assertEqual(derive_login_key(token, 1), "Snl5qN-g")


if __name__ == "__main__":
    unittest.main()
