import axios from "axios";
import bencode from "bencode";
import {isEqual} from "lodash";
import log4js from "log4js";
import {config, state} from "./downTorrent";

const logger = log4js.getLogger("Tracker");
logger.level = "error";

export class Tracker {
  private _trackerUrl: string;
  private _peerAddrs: string[];

  public constructor(trackerUrl: string) {
    this._trackerUrl = trackerUrl;
    this._peerAddrs = [];
  }

  public get trackerUrl() {
    return this._trackerUrl;
  }

  public get peerAddrs() {
    return this._peerAddrs;
  }

  // fetch and refresh peer list of current tracker
  public async updatePeerList(): Promise<void> {
    let trackerResponse = null;
    try {
      trackerResponse = await axios({
        url: this.getQueryUrl(),
        method: "GET",
        responseType: "arraybuffer",
        timeout: 10000,
      });
    } catch (err) {
      logger.warn("[%s] get peers from tracker error: %s", this._trackerUrl, err.message);
      return;
    }

    if (trackerResponse.status != 200) {
      logger.warn("[%s] get peers from tracker error: %s", this._trackerUrl, trackerResponse.statusText);
      return;
    }

    // decode peers data
    const trackerResponseData = bencode.decode(trackerResponse.data);
    if (trackerResponseData["failure reason"]) {
      const failureReason = bencode.encode(trackerResponseData["failure reason"]).toString();
      logger.warn("[%s] get peers from tracker error: %s", this._trackerUrl, failureReason);
      return;
    }
    if (!(trackerResponseData.peers instanceof Array) && !(trackerResponseData.peers instanceof Buffer)) {
      logger.warn("[%s] get peers from tracker failed: unexpected peers data", this._trackerUrl);
      return;
    }

    // update peers
    const peerAddrs = [];
    if (trackerResponseData.peers instanceof Array) { // normal notation
      trackerResponseData.peers.forEach((peer: {ip: Buffer, port: number}) => {
        peerAddrs.push(`${peer.ip.toString()}:${peer.port}`);
      });
    } else { // compact notation
      const peerBuf = trackerResponseData.peers as Buffer;
      for (let i = 0; i < peerBuf.length; i += 6) {
        const host = `${peerBuf.readUInt8(i)}.${peerBuf.readUInt8(i + 1)}.${peerBuf.readUInt8(i + 2)}.${peerBuf.readUInt8(i + 3)}`;
        const port = `${peerBuf.readUInt16BE(i + 4)}`
        peerAddrs.push(`${host}:${port}`);
      }
    }
    this.updatePeerAddrs(peerAddrs);
  }

  // update peer list
  private updatePeerAddrs(peerAddrs: string[]) {
    const newPeerAddrs = peerAddrs.filter(peer => this._peerAddrs.every(oldPeer => !isEqual(peer, oldPeer)));
    const newPeersCount = newPeerAddrs.length;
    const delPeersCount = this._peerAddrs.length - peerAddrs.length + newPeersCount;
    if (newPeersCount > 0 || delPeersCount > 0) {
      logger.info("[%s] get %s new peers, %s peers out-dated", this._trackerUrl, newPeerAddrs.length, delPeersCount);
    }
    this._peerAddrs = peerAddrs;
  }

  // get query url for current torrent
  private getQueryUrl(): string {
    const infoHashEncoded = state.torrent.infoHash.toUpperCase().replace(/[0-9A-F]{2}/g, hh => `%${hh}`);
    return this._trackerUrl +
      "?info_hash=" + infoHashEncoded +
      "&peer_id=" + config.peerId +
      "&port=6881" +
      "&downloaded=0" +
      "&uploaded=0" +
      "&left=" + state.torrent.length +
      "&event=started";
  }
}
