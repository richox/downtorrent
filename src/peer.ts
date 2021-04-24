import log4js from "log4js";
import moment, {Moment} from "moment";
import net from 'net';
import {config, state} from './downTorrent';
import {
  decodeMessage,
  encodeMessage,
  PeerBitfieldMessage,
  PeerHandshakeMessage,
  PeerHaveMessage,
  PeerMessage,
  PeerMessageType,
  PeerPieceMessage,
  PeerRequestOrCancelMessage
} from "./peerMessage";
import {BitSet} from "./util/bitSet";

const logger = log4js.getLogger("Peer");
logger.level = "info";

export class Peer {
  private static readonly numConcurrentDownloadingSubPieces: number = 4;
  _createTime: Moment;
  _peerAddr: string;
  _host: string;
  _port: number;
  _socket: net.Socket;
  _socketConnected: boolean = false;
  _incomingBuffer: Buffer = Buffer.alloc(0);

  _handshaked: boolean = false;
  _bitfield: BitSet;

  _downloadingPieceIndex: number = null;
  _downloadingSubPieceOffset: number = null;
  _downloadingSubPieces: number = 0;

  public constructor(peerAddr: string) {
    this._createTime = moment();
    this._peerAddr = peerAddr;
    this._host = peerAddr.split(":")[0];
    this._port = parseInt(peerAddr.split(":")[1]);
    this.connect();
    setInterval(() => this.keepAlive(), 30000);
  }

  public get createTime() {
    return this._createTime;
  }

  public get peerAddr() {
    return this._peerAddr;
  }

  public get host() {
    return this._host;
  }

  public get port() {
    return this._port;
  }

  public get connected() {
    return this._socketConnected;
  }

  private connect() {
    logger.info("[%s] trying to connect peer", this._peerAddr);
    this._socket = net.createConnection(this._port, this._host);
    this._socket.on("connect", () => {
      this._socketConnected = true;
      const handshakeMessage: PeerHandshakeMessage = {
        messageType: PeerMessageType.HANDSHAKE,
        infoHash: state.torrent.infoHash,
        peerId: config.peerId,
      };
      logger.debug("[%s] send Handshake message: %s", this._peerAddr, handshakeMessage);
      this._socket.write(encodeMessage(handshakeMessage));


    });

    this._socket.on("data", buffer => {
      this._incomingBuffer = Buffer.concat([this._incomingBuffer, buffer]);
      try {
        const decoded = decodeMessage(this._incomingBuffer);
        if (decoded != null) {
          this._incomingBuffer = this._incomingBuffer.slice(decoded.messageLength);
          this.processMessage(decoded.message);
        }
      } catch (err) {
        this._socket.end();
        this._socket.destroy(Error(`received invalid message: ${err}`));
        throw err;
      }
    });

    this._socket.on("error", err => {
      logger.info("[%s] error: %s", this._peerAddr, err.message);
      this._socket.end();
      this._socket.destroy(err);
    });

    this._socket.on("close", () => {
      this._socketConnected = false;
      this._socket.destroy();
    });
  }

  private keepAlive() {
    if (this._socketConnected) {
      logger.debug("[%s] send KeepAlive message", this._peerAddr);
      this._socket.write(encodeMessage({
        messageType: PeerMessageType.KEEP_ALIVE,
      }));
    }
  }

  private processMessage(message: PeerMessage) {
    switch (message.messageType) {
      case PeerMessageType.HANDSHAKE:      return this.processHandshakeMessage(message as PeerHandshakeMessage);
      case PeerMessageType.CHOKE:          return this.processChokeMessage();
      case PeerMessageType.UNCHOKE:        return this.processUnchokeMessage();
      case PeerMessageType.INTERESTED:     return this.processInterestedMessage();
      case PeerMessageType.NOT_INTERESTED: return this.processNotInterestedMessage();
      case PeerMessageType.HAVE:           return this.processHaveMessage(message as PeerHaveMessage);
      case PeerMessageType.BITFIELD:       return this.processBitfieldMessage(message as PeerBitfieldMessage);
      case PeerMessageType.REQUEST:        return this.processRequestMessage(message as PeerRequestOrCancelMessage);
      case PeerMessageType.PIECE:          return this.processPieceMessage(message as PeerPieceMessage);
      case PeerMessageType.CANCEL:         return this.processCancelMessage(message);
    }
  }

  private processHandshakeMessage(message: PeerHandshakeMessage) {
    if (message.infoHash.toUpperCase() != state.torrent.infoHash.toUpperCase()) {
      throw Error("info hash mismatched in handshake response");
    }
    this._handshaked = true;
    logger.debug("[%s] send Interested message", this._peerAddr);
    this._socket.write(encodeMessage({messageType: PeerMessageType.INTERESTED}));
  }

  private processChokeMessage() {
    logger.debug("[%s] received Choke message", this._peerAddr);
  }

  private processUnchokeMessage() {
    this.downloadNextSubPieces();
  }

  private processInterestedMessage() {
    logger.debug("[%s] received Interested message", this._peerAddr);
  }

  private processNotInterestedMessage() {
    logger.debug("[%s] received NotInterested message", this._peerAddr);
  }

  private processHaveMessage(message: PeerHaveMessage) {
    logger.debug("[%s] received Have message", this._peerAddr);
  }

  private processBitfieldMessage(message: PeerBitfieldMessage) {
    const expectedBitfieldLength = Math.trunc((state.torrent.pieces?.length + 7) / 8);
    if (message.bitfield.length != expectedBitfieldLength) {
      throw Error(`unexpected bitfield length: ${message.bitfield.length}, expect: ${expectedBitfieldLength}`);
    }
    this._bitfield = new BitSet(state.torrent.pieces?.length, message.bitfield);
  }

  private processRequestMessage(message: PeerRequestOrCancelMessage) {
    logger.debug("[%s] received Request message:", this._peerAddr, message);
  }

  private processPieceMessage(message: PeerPieceMessage) {
    logger.debug("[%s] received Piece message:", this._peerAddr, message);
    state.pieces[message.pieceIndex].savePiece(message.pieceData, message.blockOffset);
    this._downloadingSubPieces -= 1;
    this.downloadNextSubPieces();
  }

  private processCancelMessage(message: PeerMessage) {
    logger.debug("[%s] received Cancel message", this._peerAddr);
  }

  private downloadNextSubPieces() {
    while (this._downloadingSubPieces < Peer.numConcurrentDownloadingSubPieces) {
      this._downloadingSubPieces += 1;
      this.downloadNextSubPiece();
    }
  }

  private downloadNextSubPiece() {
    // downloadingPieceIndex not downloadable, select a new random one
    if (this._downloadingPieceIndex == null
      || this._bitfield.getBit(this._downloadingPieceIndex) == false
      || state.pieces[this._downloadingPieceIndex].completed
    ) {
      const downloadablePieceIndexes = state.pieces
        .map((piece, pieceIndex) => !piece.completed ? pieceIndex : null)
        .filter(pieceIndex => pieceIndex != null)
        .filter(pieceIndex => this._bitfield.getBit(pieceIndex));
      if (downloadablePieceIndexes.length == 0) { // no more pieces can be downloaded from this peer, close it
        this._socket.end();
        return;
      }
      this._downloadingPieceIndex = downloadablePieceIndexes[Math.trunc(Math.random() * downloadablePieceIndexes.length)];
      this._downloadingSubPieceOffset = 0;
    }

    const {
      subPieceOffset,
      subPieceLength,
    } = state.pieces[this._downloadingPieceIndex].getFirstIncompletedSubPiece(this._downloadingSubPieceOffset);

    const requestMessage: PeerRequestOrCancelMessage = {
      messageType: PeerMessageType.REQUEST,
      pieceIndex: this._downloadingPieceIndex,
      blockOffset: subPieceOffset,
      pieceLength: subPieceLength,
    };
    logger.debug("[%s] send Request message:", this._peerAddr, requestMessage);
    this._socket.write(encodeMessage(requestMessage));
    this._downloadingSubPieceOffset = subPieceOffset + subPieceLength;
    if ( this._downloadingSubPieceOffset >= state.pieces[this._downloadingPieceIndex].pieceLength) {
      this._downloadingPieceIndex = (this._downloadingPieceIndex + 1) % state.pieces.length;
      this._downloadingSubPieceOffset = 0;
    }
  }

}
