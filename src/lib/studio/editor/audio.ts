import SignalsmithStretch, { type StretchNode } from "signalsmith-stretch";
import workletUrl from "signalsmith-stretch?url";
import { t } from "../../i18n";
import { readArtifactBase64 } from "../artifacts";
import type { StudioArtifact } from "../types";
import { type EditorClip, type EditorDocument, fps, sourceFrame, valueAt } from "./document";

// Serve the pinned package as a same-origin module. Do not weaken script-src
// to blob: just to let the library construct its fallback worklet dynamically.
SignalsmithStretch.moduleUrl = workletUrl;
interface Sound {
  node: StretchNode;
  gain: GainNode;
}
export function audioSchedule(
  clip: EditorClip,
  startFrame: number,
  rate: number,
): Array<{ frame: number; input: number; speed: number; gain: number }> {
  const from = Math.max(0, startFrame - clip.start),
    output: Array<{ frame: number; input: number; speed: number; gain: number }> = [];
  // One constant-rate segment per picture frame. Its rate is the exact mean
  // over that frame: audio and the picture's integrated ramp meet at every cut.
  for (let frame = from; frame < clip.duration; frame++) {
    const a = sourceFrame(clip, frame),
      b = sourceFrame(clip, Math.min(clip.duration, frame + 1));
    const fade = Math.min(
      1,
      clip.fadeIn ? frame / clip.fadeIn : 1,
      clip.fadeOut ? (clip.duration - frame) / clip.fadeOut : 1,
    );
    output.push({
      frame: clip.start + frame,
      input: a / rate,
      speed: b - a,
      gain: valueAt(clip.properties.volume, frame, 1) * fade,
    });
  }
  return output;
}
/** Both the monitor and recorder route sound through this same DSP graph. */
export class EditorAudio {
  private context = new AudioContext();
  private destination?: MediaStreamAudioDestinationNode;
  private sounds = new Map<string, Sound>();
  private decoded = new Map<string, Promise<AudioBuffer | undefined>>();
  private disposed = false;
  readonly warnings: string[] = [];
  async prepare(
    doc: EditorDocument,
    artifacts: StudioArtifact[],
    capture: boolean,
  ): Promise<MediaStream | undefined> {
    if (!this.context.audioWorklet)
      throw new Error(
        t(
          "Your device cannot run the montage audio processor. Update the app or export the editable montage.",
        ),
      );
    if (capture && !this.destination)
      this.destination = this.context.createMediaStreamDestination();
    for (const clip of doc.clips) {
      if (this.disposed) return;
      const track = doc.tracks.find((track) => track.id === clip.trackId);
      if (track?.muted || track?.hidden) continue;
      const artifact = artifacts.find((a) => a.id === clip.artifactId);
      if (!artifact || artifact.kind === "image") continue;
      let sound = this.sounds.get(clip.id);
      if (!sound) {
        let decoded = this.decoded.get(artifact.id);
        if (!decoded) {
          decoded = this.decode(artifact);
          this.decoded.set(artifact.id, decoded);
        }
        const buffer = await decoded;
        if (!buffer || this.disposed) continue;
        const node = await SignalsmithStretch(this.context, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [buffer.numberOfChannels],
        });
        if (this.disposed) {
          node.disconnect();
          node.port.close();
          return;
        }
        await node.addBuffers(
          Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
            buffer.getChannelData(channel),
          ),
        );
        const gain = this.context.createGain();
        node.connect(gain);
        sound = { node, gain };
        this.sounds.set(clip.id, sound);
      }
      sound.gain.disconnect();
      sound.gain.connect(capture && this.destination ? this.destination : this.context.destination);
    }
    for (const [id, sound] of this.sounds)
      if (!doc.clips.some((c) => c.id === id)) {
        sound.node.disconnect();
        sound.node.port.close();
        sound.gain.disconnect();
        this.sounds.delete(id);
      }
    await this.context.resume();
    return this.destination?.stream;
  }
  private async decode(artifact: StudioArtifact): Promise<AudioBuffer | undefined> {
    const base64 = await readArtifactBase64(artifact);
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    try {
      return await this.context.decodeAudioData(bytes.buffer);
    } catch {
      if (artifact.kind === "video") {
        this.warnings.push(
          t("No decodable audio was found in {name}. Its picture will play silently.", {
            name: artifact.fileName,
          }),
        );
        return;
      }
      throw new Error(
        t("Could not decode the sound in {name}. Remove or mute it before exporting.", {
          name: artifact.fileName,
        }),
      );
    }
  }
  /** Schedule ahead of the shared clock so the DSP can compensate its latency. */
  async start(doc: EditorDocument, frame: number): Promise<number> {
    this.pause();
    await this.context.resume();
    const latency = Math.max(
      0.15,
      ...(await Promise.all([...this.sounds.values()].map((sound) => sound.node.latency()))),
    );
    const start = this.context.currentTime + latency + 0.1;
    for (const clip of doc.clips) {
      const sound = this.sounds.get(clip.id),
        track = doc.tracks.find((track) => track.id === clip.trackId);
      if (!sound || track?.muted || track?.hidden || clip.start + clip.duration <= frame) continue;
      sound.gain.gain.cancelScheduledValues(0);
      sound.gain.gain.setValueAtTime(0, this.context.currentTime);
      for (const point of audioSchedule(clip, frame, fps(doc))) {
        const output = start + (point.frame - frame) / fps(doc);
        void sound.node.schedule({
          active: true,
          output,
          input: point.input,
          rate: point.speed,
          semitones: 0,
          formantCompensation: true,
          formantBaseHz: 0,
        });
        sound.gain.gain.linearRampToValueAtTime(point.gain, output);
      }
      const stop = start + (clip.start + clip.duration - frame) / fps(doc);
      void sound.node.schedule({ active: false, output: stop });
      sound.gain.gain.setValueAtTime(0, stop);
    }
    return performance.now() + Math.max(0, start - this.context.currentTime) * 1000;
  }
  pause() {
    for (const sound of this.sounds.values()) {
      void sound.node.schedule({
        active: false,
        output: this.context.currentTime,
      });
      sound.gain.gain.cancelScheduledValues(0);
      sound.gain.gain.setValueAtTime(0, this.context.currentTime);
    }
  }
  dispose() {
    this.disposed = true;
    this.pause();
    for (const sound of this.sounds.values()) {
      sound.node.disconnect();
      sound.node.port.close();
      sound.gain.disconnect();
    }
    this.sounds.clear();
    void this.context.close();
  }
}
