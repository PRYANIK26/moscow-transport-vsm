class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = true;
    this.buffer = [];
    this.size = 0;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        this.recording = false;
        this.flush();
        this.port.postMessage("stopped");
      }
    };
  }
  flush() {
    if (!this.size) return;
    const samples = new Float32Array(this.size);
    let offset = 0;
    for (const block of this.buffer) {
      samples.set(block, offset);
      offset += block.length;
    }
    this.port.postMessage(samples, [samples.buffer]);
    this.buffer = [];
    this.size = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (this.recording && input) {
      this.buffer.push(new Float32Array(input));
      this.size += input.length;
      if (this.size >= 2048) this.flush();
    }
    return true;
  }
}
registerProcessor("pcm-recorder", PcmRecorderProcessor);
