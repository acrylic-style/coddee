import { Transform, type TransformCallback } from "node:stream";

export class DiscordPcmToRealtimePcm extends Transform {
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const sampleFrames = Math.floor(chunk.length / 4);
    const output = Buffer.allocUnsafe(Math.ceil(sampleFrames / 2) * 2);
    let outputOffset = 0;

    for (let frame = 0; frame < sampleFrames; frame += 2) {
      const inputOffset = frame * 4;
      const left = chunk.readInt16LE(inputOffset);
      const right = chunk.readInt16LE(inputOffset + 2);
      output.writeInt16LE(Math.round((left + right) / 2), outputOffset);
      outputOffset += 2;
    }

    callback(null, output.subarray(0, outputOffset));
  }
}
