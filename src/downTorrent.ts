import fs from "fs";
import {shuffle, sum} from "lodash";
import log4js from "log4js";
import moment from "moment";
import numeral from "numeral";
import parseTorrent, {Instance as TorrentInstance} from "parse-torrent";
import externalTrackerList from "./externalTrackerList";
import {Peer} from "./peer";
import {Piece} from "./piece";
import {Tracker} from "./tracker";

const logger = log4js.getLogger("DownTorrent");
logger.level = "info";

// config
export const config: {
  peerId: string;
  downloadPath: string;
  torrentFileName: string;
  numMaxCompletedPieceCacheSize: number;
} = {
  peerId: "-BT0001-000000000000",
  downloadPath: "./downloads",
  torrentFileName: process.argv[process.argv.length - 1],
  numMaxCompletedPieceCacheSize: 16777216,
};

// initialize state
export const state: {
  torrent: TorrentInstance;
  running: boolean;
  trackers: Tracker[];
  peers: Peer[];
  pieces: Piece[];
} = {
  torrent: parseTorrent(fs.readFileSync(config.torrentFileName)) as TorrentInstance,
  running: true,
  trackers: [],
  peers: [],
  pieces: [],
};
state.pieces = Array.from({length: state.torrent.pieces?.length}, (_, pieceIndex) => {
  return new Piece(pieceIndex, state.torrent.pieceLength, state.torrent.pieces[pieceIndex]);
});

// print download file info
state.torrent.files.forEach(file => {
  logger.info("torrent file: [%sB] - %s", numeral(file.length).format("0.00a").toUpperCase(), file.name);
});

// update peer list
const updatePeerList = (() => {
  if (state.trackers.length == 0) {
    state.trackers = [...state.torrent.announce, ...externalTrackerList].map(trackerUrl => new Tracker(trackerUrl));
  }
  state.trackers.forEach(tracker => {
    tracker.updatePeerList().then(() => {
      tracker.peerAddrs.forEach(peerAddr => {
        if (state.peers.every(peer => peer.peerAddr != peerAddr)) {
          state.peers.push(new Peer(peerAddr));
        }
      });
    }).catch(err => {
      logger.debug(err.message);
    });
  });
});
updatePeerList();
setInterval(updatePeerList, 60000);

// clean out-dated peers
setInterval(() => {
  const now = moment();
  state.peers = state.peers.filter(peer => {
    if (!peer.connected && now.diff(peer.createTime, "ms") > 30000) { // disconnected for longer than 30s
      logger.info("remove out-dated peer: %s", peer.peerAddr);
      return false;
    }
    return true;
  });
}, 5000);

// clear completed piece cache
setInterval(() => {
  const completedCachedPieces = state.pieces.filter(piece => piece.completed && piece.cached);
  const cacheSize = sum(completedCachedPieces.map(piece => piece.pieceLength));
  logger.debug("completed cached size: %sB", numeral(cacheSize).format("0.00a").toUpperCase());
  if (cacheSize > config.numMaxCompletedPieceCacheSize) {
    shuffle(completedCachedPieces).slice(0, completedCachedPieces.length / 2).forEach(piece => piece.clearCache());
  }
}, 5000);

// print tracker and peer statistics
setInterval(() => {
  let numActiveTrackers = 0;
  let numPeers = 0;
  state.trackers.forEach(tracker => {
    numActiveTrackers += Number(tracker.peerAddrs.length > 0);
    numPeers += tracker.peerAddrs.length;
  });
  logger.info(
    `total active trackers: ${numActiveTrackers}, ` +
    `peers: ${numPeers}, ` +
    `active peers: ${state.peers.filter(peer => peer.connected).length}`
  );
}, 5000);

// print download progress and speed
const numTotalSubPieces = sum(state.pieces.map(piece => piece.subPieceTotalCount));
const numStartCompletedSubPieces = 0;
const startTime = moment();
setInterval(() => {
  const numCompletedSubPieces = sum(state.pieces.map(piece => piece.subPieceCompletedCount));

  const completedRatio = numCompletedSubPieces / numTotalSubPieces;
  const speed = (numCompletedSubPieces - numStartCompletedSubPieces) * Piece.subPieceLength * 1000 / moment().diff(startTime, "ms")
  logger.info(
    `progress: ${numeral(completedRatio).format("0.00%")}, ` +
    `speed: ${numeral(speed).format("0.00a").toUpperCase()}B/s`
  );
  if (completedRatio >= 1) {
    logger.info("download finished!");
    process.exit();
  }
}, 1000);
