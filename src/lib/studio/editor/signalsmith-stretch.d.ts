declare module "signalsmith-stretch" {
  export interface StretchSchedule {
    active?: boolean;
    output?: number;
    input?: number;
    rate?: number;
    semitones?: number;
    formantCompensation?: boolean;
    formantSemitones?: number;
    formantBaseHz?: number;
  }
  export interface StretchNode extends AudioWorkletNode {
    schedule(options: StretchSchedule): Promise<unknown>;
    addBuffers(channels: Float32Array[]): Promise<number>;
    stop(when?: number): Promise<unknown>;
    latency(): Promise<number>;
  }
  const SignalsmithStretch: {
    (context: AudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>;
    moduleUrl?: string;
  };
  export default SignalsmithStretch;
}
