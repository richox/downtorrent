export class BitSet {
  _length: number;
  _buf: Buffer;

  public constructor(length: number, buf?: Buffer) {
    this._length = length;
    this._buf = Buffer.alloc(Math.trunc(length + 7) / 8);
    if (buf) {
      buf.copy(this._buf);
    }
  }

  public get length() {
    return this._length;
  }

  public get buf() {
    return this._buf;
  }

  public getBit(i: number): boolean {
    const div = Math.trunc(i / 8);
    const mod = i % 8;
    return ((this._buf.readUInt8(div) << mod) & 0x80) == 0x80;
  }

  public putBit(i: number, value: boolean) {
    const div = Math.trunc(i / 8);
    const mod = i % 8;
    if (value) {
      this._buf.writeUInt8(this._buf.readUInt8(div) | (0x80 >> mod), div);
    } else {
      this._buf.writeUInt8(this._buf.readUInt8(div) & (0xff ^ (0x80 >> mod)), div);
    }
  }
}
