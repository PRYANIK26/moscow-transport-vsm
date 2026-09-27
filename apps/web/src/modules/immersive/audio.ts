export function encodePcm(chunks: Float32Array[], rate: number): ArrayBuffer {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const ratio = rate / 16000;
  const output = new ArrayBuffer(Math.floor(length / ratio) * 2);
  const view = new DataView(output);
  for (let i = 0; i < output.byteLength / 2; i++) {
    const begin = Math.floor(i * ratio);
    const end = Math.min(
      length,
      Math.max(begin + 1, Math.floor((i + 1) * ratio)),
    );
    let sum = 0;
    for (let j = begin; j < end; j++) sum += merged[j];
    const sample = Math.max(-1, Math.min(1, sum / (end - begin)));
    view.setInt16(
      i * 2,
      Math.round(sample * (sample < 0 ? 32768 : 32767)),
      true,
    );
  }
  return output;
}
export class PcmRecorder {
  private chunks: Float32Array[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private done?: (audio: ArrayBuffer) => void;
  private stopped = false;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private constructor(
    private context: AudioContext,
    private stream: MediaStream,
    private node: AudioWorkletNode,
  ) {
    node.port.onmessage = (e) => {
      if (e.data instanceof Float32Array) this.chunks.push(e.data);
      if (e.data === "stopped") {
        const data = encodePcm(this.chunks, this.context.sampleRate);
        this.cleanup();
        this.done?.(data);
      }
    };
  }
  static async start(onLimit: () => void) {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error(
        "Микрофон доступен в поддерживаемом браузере на localhost или HTTPS.",
      );
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      stream?.getTracks().forEach((t) => t.stop());
      if (context && context.state !== "closed") void context.close();
    };
    const unavailable = () => new Error(
      "Не удалось подключить микрофон за 15 секунд. Проверьте разрешение браузера и выбранное устройство. Текстовый ввод доступен.",
    );
    const checkCancelled = () => {
      if (cancelled) {
        release();
        throw unavailable();
      }
    };
    try {
      return await Promise.race([
        (async () => {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
            },
          });
          checkCancelled();
          context = new AudioContext({ sampleRate: 16000 });
          await context.audioWorklet.addModule("/pcm-worklet.js");
          checkCancelled();
          await context.resume();
          checkCancelled();
          const node = new AudioWorkletNode(context, "pcm-recorder");
          const source = context.createMediaStreamSource(stream);
          source.connect(node);
          node.connect(context.destination);
          const recorder = new PcmRecorder(context, stream, node);
            recorder.timer = setTimeout(onLimit, 19000);
          return recorder;
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            cancelled = true;
            release();
            reject(unavailable());
          }, 15000);
        }),
      ]);
    } catch (err) {
      cancelled = true;
      release();
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
  stop(): Promise<ArrayBuffer> {
    if (this.stopped)
      return Promise.reject(new Error("Запись уже остановлена."));
    this.stopped = true;
    clearTimeout(this.timer);
    return new Promise((resolve, reject) => {
      this.stopTimer = setTimeout(() => {
        this.cleanup();
        reject(new Error("Микрофон перестал отвечать. Повторите запись."));
      }, 5000);
      this.done = resolve;
      this.node.port.postMessage("stop");
    });
  }
  cancel() {
    this.stopped = true;
    this.cleanup();
  }
  private cleanup() {
    clearTimeout(this.timer);
    clearTimeout(this.stopTimer);
    this.stream.getTracks().forEach((t) => t.stop());
    this.node.disconnect();
    void this.context.close();
  }
}
