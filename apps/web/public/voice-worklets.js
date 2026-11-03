/* Audio runs off the UI thread. No provider credentials or network access. */
class TokaiCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.area = 0; this.weight = 0; this.buffer = new Int16Array(800); this.count = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'flush') this.send(true);
      if (data.type === 'reset') { this.area = 0; this.weight = 0; this.count = 0; }
    };
  }
  send(final = false) {
    const samples = this.buffer.slice(0, this.count);
    let square = 0;
    for (let i = 0; i < samples.length; i++) square += (samples[i] / 32768) ** 2;
    this.port.postMessage({ type: 'pcm', samples, rms: samples.length ? Math.sqrt(square / samples.length) : 0, final }, [samples.buffer]);
    this.count = 0;
  }
  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    const channels = inputs[0]; if (!channels?.length) return true;
    const length = channels[0].length;
    for (let i = 0; i < length; i++) {
      let value = 0; for (const channel of channels) value += channel[i]; value /= channels.length;
      let remaining = 1;
      // Integrate each capture sample over the destination sample interval.
      // Fractional weight survives render quanta (44.1k and 48k both work).
      while (remaining > 1e-9) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.area += value * take; this.weight += take; remaining -= take;
        if (this.weight >= this.ratio - 1e-9) {
          const normalized = Math.max(-1, Math.min(1, this.area / this.ratio));
          this.buffer[this.count++] = Math.round(normalized * (normalized < 0 ? 32768 : 32767));
          this.area = 0; this.weight = 0;
          if (this.count === 800) this.send();
        }
      }
    }
    return true;
  }
}

class TokaiPlayback extends AudioWorkletProcessor {
  constructor() {
    super(); this.epoch = 0; this.streams = []; this.queued = 0; this.ticks = 0;
    this.port.onmessage = ({ data }) => this.receive(data);
  }
  ack(stream, status) { this.port.postMessage({ type: 'ack', outputEpoch: stream.epoch, streamId: stream.id, playedSamples: Math.min(stream.total, Math.floor(stream.position)), status }); }
  receive(data) {
    if (data.type === 'clear') {
      for (const stream of this.streams) this.ack(stream, 'interrupted');
      this.streams = []; this.queued = 0; this.epoch = data.epoch;
      return;
    }
    if (data.epoch !== this.epoch) return;
    if (data.type === 'start') {
      if (!this.streams.some(stream => stream.id === data.streamId)) this.streams.push({ id: data.streamId, epoch: data.epoch, chunks: [], total: 0, offset: 0, position: 0, ended: false, started: false, underrun: false, ready: data.ready !== false });
      return;
    }
    const stream = this.streams.find(item => item.id === data.streamId); if (!stream) return;
    if (data.type === 'release') stream.ready = true;
    if (data.type === 'end') stream.ended = true;
    if (data.type === 'chunk') {
      if (!(data.samples instanceof Int16Array) || !data.samples.length) return;
      if (this.queued + data.samples.length > 24000 * 8) { this.port.postMessage({ type: 'overflow' }); return; }
      stream.chunks.push(data.samples); stream.total += data.samples.length; this.queued += data.samples.length; stream.underrun = false;
    }
  }
  sample(stream, index) {
    let local = index - stream.offset;
    for (const chunk of stream.chunks) { if (local < chunk.length) return chunk[Math.max(0, local)] / 32768; local -= chunk.length; }
    return 0;
  }
  process(_inputs, outputs) {
    const output = outputs[0]?.[0]; if (!output) return true; output.fill(0);
    const ratio = 24000 / sampleRate;
    for (let i = 0; i < output.length; i++) {
      let stream = this.streams[0];
      while (stream && stream.ended && stream.position >= stream.total) { this.ack(stream, 'completed'); this.streams.shift(); this.queued -= Math.max(0, stream.total - stream.offset); stream = this.streams[0]; }
      if (!stream) break;
      if (!stream.ready) continue;
      const index = Math.floor(stream.position);
      if (index >= stream.total || (!stream.ended && index + 1 >= stream.total)) {
        if (stream.started && !stream.underrun) { stream.underrun = true; this.ack(stream, 'underrun'); }
        continue;
      }
      if (!stream.started) { stream.started = true; this.ack(stream, 'started'); }
      const a = this.sample(stream, index), b = index + 1 < stream.total ? this.sample(stream, index + 1) : a;
      output[i] = a + (b - a) * (stream.position - index); stream.position = Math.min(stream.total, stream.position + ratio);
      while (stream.chunks.length > 1 && stream.position >= stream.offset + stream.chunks[0].length) { const size = stream.chunks.shift().length; stream.offset += size; this.queued -= size; }
    }
    this.ticks += output.length;
    if (this.ticks >= sampleRate / 5) { this.ticks = 0; if (this.streams[0]?.started) this.ack(this.streams[0], 'progress'); }
    // Mono to every configured channel, without advancing the source clock twice.
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(output);
    return true;
  }
}
registerProcessor('tokai-capture', TokaiCapture);
registerProcessor('tokai-playback', TokaiPlayback);
