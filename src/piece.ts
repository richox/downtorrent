import fs from 'fs';
import {config, state} from "./downTorrent";

export class Piece {
  public static readonly subPieceLength: number = 16384;

  _pieceIndex: number;
  _pieceLength: number;
  _pieceHash: string;

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

  public get completed(): boolean {
    return this.subPieceCompletedCount == this.subPieceTotalCount;
  }

  public get subPieceTotalCount(): number {
    return this._subPieceCompleted.length;
  }

  public get subPieceCompletedCount(): number {
    return this._subPieceCompletedCount;
  }

  public savePiece(subPieceData: Buffer, subPieceOffset: number) {
    if (subPieceOffset + subPieceData.length > this._pieceLength) {
      throw Error(`received piece length overflow: ${subPieceOffset + subPieceData.length}, sub piece length: ${subPieceData.length}`);
    }
    const subPieceIndex = subPieceOffset / Piece.subPieceLength;
    if (!this._subPieceCompleted[subPieceIndex]) {
      this.writeSubPieceToFile(this._pieceIndex, subPieceData, subPieceOffset);
      this._subPieceCompleted[subPieceIndex] = true;
      this._subPieceCompletedCount += 1;
    }
  }

  public getRandomIncompletedSubPiece(): {
    subPieceOffset: number;
    subPieceLength: number;
  } {
    const subPieceIndexes = this._subPieceCompleted
      .map((completed, subPieceIndex) => !completed ? subPieceIndex : null)
      .filter(subPieceIndex => subPieceIndex != null);
    const subPieceIndex = subPieceIndexes[Math.trunc(Math.random() * subPieceIndexes.length)];
    const subPieceOffset = subPieceIndex * Piece.subPieceLength;
    const subPieceLength = Math.min(Piece.subPieceLength, this._pieceLength - subPieceOffset);
    return {
      subPieceOffset,
      subPieceLength,
    };
  }

  private writeSubPieceToFile(pieceIndex: number, subPieceData: Buffer, subPieceOffset: number) {
    interface Range {
      l: number;
      r: number;
    }
    const subPieceRange: Range = {
      l: pieceIndex * state.torrent.pieceLength + subPieceOffset,
      r: pieceIndex * state.torrent.pieceLength + subPieceOffset + subPieceData.length,
    };

    for (let fileIndex = 0; fileIndex < state.torrent.files?.length; fileIndex++) {
      const file = state.torrent.files[fileIndex];
      const fileRange = {
        l: file.offset,
        r: file.offset + file.length,
      };

      if (subPieceRange.l >= fileRange.l && subPieceRange.l < fileRange.r) {
        // subPiece:     |---->
        // file1:     |--*-->
        // file2:     |--*------>
        this.writeFile(`${config.downloadPath}/${file.name}`,
          subPieceRange.l - fileRange.l, subPieceData.slice(0, fileRange.r - subPieceRange.l));
        continue;
      }
      if (subPieceRange.r >= fileRange.l && subPieceRange.r < fileRange.r) {
        // subPiece:  |--*-->
        // file1:        |---->
        // file2:        |->
        this.writeFile(`${config.downloadPath}/${file.name}`,
          0, subPieceData.slice(fileRange.l - subPieceRange.l, fileRange.r - subPieceRange.l));
      }
      continue;
    }
  }

  private writeFile(filename: string, offset: number, buffer: Buffer) {
    const fd = fs.openSync(filename, fs.existsSync(filename) ? "r+" : "w+");
    fs.writeSync(fd, buffer, 0, buffer.length, offset);
    fs.closeSync(fd);
  }
}