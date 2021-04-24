import crypto from "crypto";
import fs from "fs";
import {config, state} from "./downTorrent";

interface Range {
  l: number;
  r: number;
}

export class Piece {
  public static readonly subPieceLength: number = 16384;

  _pieceIndex: number;
  _pieceLength: number;
  _pieceHash: string;
  _pieceCache: Buffer = null;

  _subPieceCompleted: boolean[];
  _subPieceCompletedCount: number;
  _completed: boolean;

  public constructor(pieceIndex: number, pieceLength: number, pieceHash: string) {
    this._pieceIndex = pieceIndex;
    this._pieceLength = pieceLength;
    this._pieceHash = pieceHash;

    this._completed = false;
    this._subPieceCompleted = Array.from({length: pieceLength / Piece.subPieceLength}, () => false);
    this._subPieceCompletedCount = 0;
  }

  public get pieceIndex() {
    return this._pieceIndex;
  }

  public get pieceLength() {
    return this._pieceLength;
  }

  public get completed(): boolean {
    return this._subPieceCompletedCount == this.subPieceTotalCount;
  }

  public get cached(): boolean {
    return this._pieceCache != null;
  }

  public get subPieceTotalCount(): number {
    return this._subPieceCompleted.length;
  }

  public get subPieceCompletedCount(): number {
    return this._subPieceCompletedCount;
  }

  public clearCache() {
    this._pieceCache = null;
  }

  public saveSubPiece(subPieceData: Buffer, subPieceOffset: number) {
    if (subPieceOffset + subPieceData.length > this._pieceLength) {
      throw Error(`received piece length overflow: ${subPieceOffset + subPieceData.length}, sub piece length: ${subPieceData.length}`);
    }

    // write sub piece to buffer
    if (!this.cached) {
      this._pieceCache = Buffer.alloc(this._pieceLength);
    }
    const subPieceIndex = Math.trunc(subPieceOffset / Piece.subPieceLength);
    if (!this._subPieceCompleted[subPieceIndex]) {
      this._subPieceCompleted[subPieceIndex] = true;
      this._subPieceCompletedCount += 1;
      subPieceData.copy(this._pieceCache, subPieceOffset);
    }

    // write piece to file if completed
    if (this.completed) {
      const sha1sum = crypto.createHash("sha1").update(this._pieceCache).digest("hex");
      if (sha1sum.toUpperCase() == state.torrent.pieces[this._pieceIndex].toLocaleUpperCase()) {
        this.writePieceToFile();
      } else {
        // checksum mismatch -- reset the whole piece
        this._subPieceCompleted.fill(false);
        this._subPieceCompletedCount = 0;
        this._completed = false;
      }
    }
  }

  public getFirstIncompletedSubPiece(subPieceOffsetHint: number = 0): {
    subPieceOffset: number;
    subPieceLength: number;
  } {

    // find first incompleted sub piece after subPieceOffsetHint
    const subPieceIndex = this._subPieceCompleted
      .findIndex((completed, i) => !completed && i * Piece.subPieceLength >= subPieceOffsetHint);
    const subPieceOffset = subPieceIndex * Piece.subPieceLength;
    const subPieceLength = Math.min(Piece.subPieceLength, this._pieceLength - subPieceOffset);
    return {
      subPieceOffset,
      subPieceLength,
    };
  }

  private writePieceToFile() {
    const subPieceRange: Range = {
      l: this._pieceIndex * state.torrent.pieceLength,
      r: this._pieceIndex * state.torrent.pieceLength + this._pieceCache.length - 1,
    };

    let fileIndex = this.findFileContainingOffset(subPieceRange.l);
    while (true) {
      const file = state.torrent.files[fileIndex];
      const fileRange = {
        l: file.offset,
        r: file.offset + file.length - 1,
      };
      const filename = `${config.downloadPath}/${file.name}`;

      if (subPieceRange.l >= fileRange.l && subPieceRange.l <= fileRange.r) {
        // subPiece:     |---->
        // file1:     |--*-->
        // file2:     |--*------>
        this.writeFile(filename, subPieceRange.l - fileRange.l, this._pieceCache.slice(0, fileRange.r - subPieceRange.l + 1));

      } else if (subPieceRange.r >= fileRange.l && subPieceRange.r <= fileRange.r) {
        // subPiece:  |--*-->
        // file1:        |---->
        // file2:        |->
        this.writeFile(filename, 0, this._pieceCache.slice(fileRange.l - subPieceRange.l, fileRange.r - subPieceRange.l + 1));
      }

      if (fileRange.r >= subPieceRange.r) { // all data written
        break;
      }
      fileIndex += 1;
    }
  }

  private writeFile(filename: string, offset: number, buffer: Buffer) {
    const fd = fs.openSync(filename, fs.existsSync(filename) ? "r+" : "w+");
    fs.writeSync(fd, buffer, 0, buffer.length, offset);
    fs.closeSync(fd);
  }

  private findFileContainingOffset(offset: number): number {
    let l = 0;
    let r = state.torrent.files.length;
    let m: number;

    while (l < r) {
      m = Math.trunc((l + r) / 2);
      const file = state.torrent.files[m];

      if (file.offset > offset) {
        r = m - 1;
        continue;
      }
      if (file.offset + file.length <= offset) {
        l = m + 1;
        continue;
      }
      break;
    }
    return m;
  }
}
