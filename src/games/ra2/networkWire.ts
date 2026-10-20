/** RA2/YR use the binary wire protocol with one-byte message types; the EXE supplies the compatibility hash and the guest player name supplies metadata. */
export {
  RELAY_MAX_LAN_MEMBERS as RA2NET_MAX_LAN_MEMBERS,
  RELAY_MAX_FRAME_BYTES as RA2NET_MAX_FRAME_BYTES,
  RELAY_MAX_DATAGRAM_BYTES as RA2NET_MAX_DATAGRAM_BYTES,
  RELAY_MAX_BUFFERED_BYTES as RA2NET_MAX_BUFFERED_BYTES,
  RELAY_SUBNET_PREFIX as RA2NET_SUBNET_PREFIX,
  RELAY_SUBNET_BROADCAST as RA2NET_SUBNET_BROADCAST,
  RELAY_HOST_OCTET_MIN as RA2NET_HOST_OCTET_MIN,
  RELAY_HOST_OCTET_COUNT as RA2NET_HOST_OCTET_COUNT,
  type RelayWire as Ra2NetworkWire,
  isRelayRoomId as isRa2NetworkRoomId,
  isRelayCompatibilityHash as isRa2ExeHash,
  encodeRelayFrame as encodeRa2NetworkFrame,
  decodeRelayFrame as decodeRa2NetworkFrame,
  isRelayWire as isRa2NetworkWire,
  isRelayBroadcastAddress as isRa2BroadcastAddress,
} from 'relay-package/wire';
