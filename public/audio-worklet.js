// Phase 1 stub — Phase 2 wires this up for live mic capture
// AudioWorkletProcessor that downsamples to 16kHz PCM and posts chunks
class PCMProcessor extends AudioWorkletProcessor {
  constructor() { super(); }
  process(inputs) {
    // No-op in Phase 1
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
