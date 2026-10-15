export type MicrophoneBuffer = {
  data: ArrayBuffer;
  sampleRate: number;
  channels: number;
  encoding: 'float32' | 'int16';
};

// Stateful linear resampling: devices may ignore a requested 16 kHz sample rate.
// Preserve the fractional cursor across callbacks to avoid gaps, duplication and drift.
export class Pcm16Resampler {
  private pending = new Float32Array(0);
  private position = 0;
  private sourceRate = 0;

  convert(buffer: MicrophoneBuffer): Uint8Array {
    if (!Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0 || buffer.channels < 1) {
      throw new Error('Invalid microphone sample format.');
    }
    if (this.sourceRate !== buffer.sampleRate) {
      this.pending = new Float32Array(0);
      this.position = 0;
      this.sourceRate = buffer.sampleRate;
    }
    const width = buffer.encoding === 'int16' ? 2 : 4;
    const view = new DataView(buffer.data);
    const frames = Math.floor(buffer.data.byteLength / width / buffer.channels);
    const samples = new Float32Array(this.pending.length + frames);
    samples.set(this.pending);
    for (let frame = 0; frame < frames; frame++) {
      let mono = 0;
      for (let channel = 0; channel < buffer.channels; channel++) {
        const offset = (frame * buffer.channels + channel) * width;
        mono += buffer.encoding === 'int16' ? view.getInt16(offset, true) / 32768 : view.getFloat32(offset, true);
      }
      samples[this.pending.length + frame] = Math.max(-1, Math.min(1, mono / buffer.channels));
    }
    const step = buffer.sampleRate / 16000;
    const output: number[] = [];
    while (this.position + 1 < samples.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      output.push(samples[index] * (1 - fraction) + samples[index + 1] * fraction);
      this.position += step;
    }
    const consumed = Math.min(Math.floor(this.position), Math.max(0, samples.length - 1));
    this.pending = samples.slice(consumed);
    this.position -= consumed;
    const bytes = new Uint8Array(output.length * 2);
    const encoded = new DataView(bytes.buffer);
    for (let index = 0; index < output.length; index++) {
      const value = output[index];
      encoded.setInt16(index * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true);
    }
    return bytes;
  }
}
