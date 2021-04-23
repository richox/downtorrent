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
  _bitfield: Buffer = Buffer.alloc(0);
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
    logger.debug(`trying to connect peer: ${this._peerAddr}`);
    this._socket = net.createConnection(this._port, this._host);
    this._socket.on("connect", () => {
      this._socketConnected = true;
      const handshakeMessage: PeerHandshakeMessage = {
        messageType: PeerMessageType.HANDSHAKE,
        infoHash: state.torrent.infoHash,
        peerId: config.peerId,
      };
      logger.debug("send Handshake message:", handshakeMessage);
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
        this._socket.destroy(Error(`received invalid message : ${err}`));
      }
    });

    this._socket.on("error", err => {
      logger.info(`peer ${this._host}:${this._port} error: ${err}`);
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
      logger.debug("send KeepAlive message");
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
    logger.debug("send Interested message");
    this._socket.write(encodeMessage({messageType: PeerMessageType.INTERESTED}));
  }

  private processChokeMessage() {
    logger.debug("received Choke message");
  }

  private processUnchokeMessage() {
    this.downloadNextSubPieces();
  }

  private processInterestedMessage() {
    logger.debug("received Interested message");
  }

  private processNotInterestedMessage() {
    logger.debug("received NotInterested message");
  }

  private processHaveMessage(message: PeerHaveMessage) {
    logger.debug("received Have message");
  }

  private processBitfieldMessage(message: PeerBitfieldMessage) {
    this._bitfield = message.bitfield;
  }

  private processRequestMessage(message: PeerRequestOrCancelMessage) {
    logger.debug("received Request message:", message);
  }

  private processPieceMessage(message: PeerPieceMessage) {
    logger.debug("received Piece message:", message);
    state.pieces[message.pieceIndex].savePiece(message.pieceData, message.blockOffset);
    this._downloadingSubPieces -= 1;
    this.downloadNextSubPieces();
  }

  private processCancelMessage(message: PeerMessage) {
    logger.debug("received Cancel message");
  }

  private hasPiece(i: number): boolean {
    let div = Math.floor(i / 8);
    let mod = i % 8;
    return ((this._bitfield.readUInt8(div) >> (7 - mod)) & 1) == 1;
  }

  private downloadNextSubPieces() {
    while (this._downloadingSubPieces < Peer.numConcurrentDownloadingSubPieces) {
      this._downloadingSubPieces += 1;
      this.downloadNextSubPiece();
    }
  }

  private downloadNextSubPiece() {
    const downloadablePieceIndexes = state.pieces
      .map((piece, pieceIndex) => !piece.completed ? pieceIndex : null)
      .filter(pieceIndex => pieceIndex != null)
      .filter(pieceIndex => this.hasPiece(pieceIndex));

    if (downloadablePieceIndexes.length == 0) { // no sub pieces can be downloaded from this peer, close it
      this._socket.end();
      return;
    }
    const pieceIndex = downloadablePieceIndexes[Math.trunc(Math.random() * downloadablePieceIndexes.length)];
    const {
      subPieceOffset,
      subPieceLength,
    } = state.pieces[pieceIndex].getRandomIncompletedSubPiece();

    const requestMessage: PeerRequestOrCancelMessage = {
      messageType: PeerMessageType.REQUEST,
      pieceIndex,
      blockOffset: subPieceOffset,
      pieceLength: subPieceLength,
    };
    logger.debug("send Request message:", requestMessage);
    this._socket.write(encodeMessage(requestMessage));
  }
}
