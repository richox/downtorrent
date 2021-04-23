export enum PeerMessageType {
  HANDSHAKE = -100,
  KEEP_ALIVE = -101,
  CHOKE = 0,
  UNCHOKE = 1,
  INTERESTED = 2,
  NOT_INTERESTED = 3,
  HAVE = 4,
  BITFIELD = 5,
  REQUEST = 6,
  PIECE = 7,
  CANCEL = 8,
}

export interface PeerMessage {
  messageType: PeerMessageType;
}
export interface PeerHandshakeMessage extends PeerMessage {
  infoHash: string;
  peerId: string;
}
export interface PeerRequestOrCancelMessage extends PeerMessage {
  pieceIndex: number;
  blockOffset: number;
  pieceLength: number;
}
export interface PeerBitfieldMessage extends PeerMessage {
  bitfield: Buffer;
}
export interface PeerHaveMessage extends PeerMessage {
  pieceNumber: number;
}
export interface PeerPieceMessage extends PeerMessage {
  pieceIndex: number;
  blockOffset: number;
  pieceData: Buffer;
}

export function encodeMessage(message: PeerMessage): Buffer {
  let buffer: Buffer;

  if (message.messageType == PeerMessageType.HANDSHAKE) {
    const handshakeMessage = message as PeerHandshakeMessage;
    buffer = Buffer.alloc(68);
    buffer.writeInt8(19, 0);
    buffer.write("BitTorrent protocol", 1);
    getRawInfoHash(handshakeMessage.infoHash).copy(buffer, 28);
    buffer.write(handshakeMessage.peerId, 48);
    return buffer;
  }
  if (message.messageType == PeerMessageType.KEEP_ALIVE) {
    buffer = Buffer.alloc(4);
    return buffer;
  }

  switch (message.messageType) {
    case PeerMessageType.CHOKE:
    case PeerMessageType.UNCHOKE:
    case PeerMessageType.INTERESTED:
    case PeerMessageType.NOT_INTERESTED:
      buffer = Buffer.alloc(5);
      break;

    case PeerMessageType.REQUEST:
    case PeerMessageType.CANCEL:
      const requestMessage = message as PeerRequestOrCancelMessage;
      buffer = Buffer.alloc(17);
      buffer.writeUInt32BE(requestMessage.pieceIndex, 5);
      buffer.writeUInt32BE(requestMessage.blockOffset, 9);
      buffer.writeUInt32BE(requestMessage.pieceLength, 13);
      break;

    case PeerMessageType.HAVE:
      const haveMessage = message as PeerHaveMessage;
      buffer = Buffer.alloc(9);
      buffer.writeUInt32BE(haveMessage.pieceNumber, 5);
      break;

    case PeerMessageType.BITFIELD:
      const bitfieldMessage = message as PeerBitfieldMessage;
      buffer = Buffer.alloc(5 + bitfieldMessage.bitfield.length);
      bitfieldMessage.bitfield.copy(buffer, 5);
      break;

    case PeerMessageType.PIECE:
      const pieceMessage = message as PeerPieceMessage;
      buffer = Buffer.alloc(13 + pieceMessage.pieceData.length);
      buffer.writeUInt32BE(5, pieceMessage.pieceIndex);
      buffer.writeUInt32BE(9, pieceMessage.blockOffset);
      pieceMessage.pieceData.copy(buffer, 13);
      break;

    default:
      throw Error(`encoded invalid peer message type: ${message.messageType}`);
  }
  buffer.writeUInt32BE(buffer.length - 4, 0);
  buffer.writeUInt8(message.messageType, 4);
  return buffer;
}

export function decodeMessage(buffer: Buffer): {
  messageLength: number,
  message: PeerMessage,
} {
  if (buffer.length >= 4) {
    const messageLength = buffer.readUInt32BE(0) + 4;

    if (messageLength == 323119476 + 4) { // "\x19Bit" -- prefix of handshake message
      const messageLength = 68;
      if (buffer.length < messageLength) {
        return null;
      }
      const message: PeerHandshakeMessage = {
        messageType: PeerMessageType.HANDSHAKE,
        infoHash: getHexDigestedInfoHash(buffer.slice(28, 48)),
        peerId: buffer.toString("utf-8", 48, 68),
      };
      return {messageLength, message};

    } else if (messageLength == 4) { // keep-alive message
      const message: PeerMessage = {
        messageType: PeerMessageType.KEEP_ALIVE,
      };
      return {messageLength, message};

    } else {
      if (buffer.length >= 5 && ![ // check message type
        PeerMessageType.CHOKE,
        PeerMessageType.UNCHOKE,
        PeerMessageType.INTERESTED,
        PeerMessageType.NOT_INTERESTED,
        PeerMessageType.HAVE,
        PeerMessageType.BITFIELD,
        PeerMessageType.REQUEST,
        PeerMessageType.PIECE,
        PeerMessageType.CANCEL,
      ].includes(buffer.readUInt8(4))) {
        throw Error(`decoded invalid peer message type: ${buffer.readUInt8(4)}`);
      }

      if (buffer.length < messageLength) {
        return null;
      }

      const messageType: PeerMessageType = buffer.readUInt8(4);
      switch (messageType) {
        case PeerMessageType.CHOKE:
        case PeerMessageType.UNCHOKE:
        case PeerMessageType.INTERESTED:
        case PeerMessageType.NOT_INTERESTED:
          return {messageLength, message: {messageType}};

        case PeerMessageType.REQUEST:
        case PeerMessageType.CANCEL:
          const requestMessage: PeerRequestOrCancelMessage = {
            messageType,
            pieceIndex: buffer.readUInt32BE(5),
            blockOffset: buffer.readUInt32BE(9),
            pieceLength: buffer.readUInt32BE(13),
          };
          return {messageLength, message: requestMessage};

        case PeerMessageType.HAVE:
          const haveMessage: PeerHaveMessage = {
            messageType,
            pieceNumber: buffer.readUInt32BE(5),
          }
          return {messageLength, message: haveMessage};

        case PeerMessageType.BITFIELD:
          const bitfieldMessage: PeerBitfieldMessage = {
            messageType,
            bitfield: buffer.slice(5),
          };
          return {messageLength, message: bitfieldMessage};

        case PeerMessageType.PIECE:
          const pieceMessage: PeerPieceMessage = {
            messageType,
            pieceIndex: buffer.readUInt32BE(5),
            blockOffset: buffer.readUInt32BE(9),
            pieceData: buffer.slice(13, messageLength),
          };
          return {messageLength, message: pieceMessage};

        default:
          throw null; // unreachable
      }
    }
  }
}

function getRawInfoHash(hexDigestedInfoHash: string): Buffer {
  if (!hexDigestedInfoHash.toUpperCase().match(/[0-9A-F]{20}/)) {
    throw Error(`invalid hex digested info hash: ${hexDigestedInfoHash}`);
  }

  const infoHashBuffer = Buffer.alloc(20);
  for (let i = 0; i < 20; i++) {
    infoHashBuffer.writeUInt8(parseInt(hexDigestedInfoHash.slice(i * 2, i * 2 + 2), 16), i);
  }
  return infoHashBuffer;
}

function getHexDigestedInfoHash(rawInfoHash: Buffer): string {
  if (rawInfoHash.length != 20) {
    throw Error(`invalid raw info hash: ${rawInfoHash}`);
  }

  let hexDigestedInfoHash = "";
  for (let i = 0; i < 20; i++) {
    hexDigestedInfoHash += rawInfoHash.readUInt8(i).toString(16).padStart(2, "0");
  }
  return hexDigestedInfoHash.toUpperCase();
}
