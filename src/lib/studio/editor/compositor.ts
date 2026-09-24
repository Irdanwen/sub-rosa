import { t } from "../../i18n";
import { messageFromError } from "../../errors";
import { EditorAudio } from "./audio";
import { artifactSrc } from "../artifacts";
import { pickRecorderMime } from "../assemble";
import type { StudioArtifact } from "../types";
import {
  type EditorClip,
  type EditorDocument,
  clipFade,
  clipOpacity,
  durationFrames,
  fps,
  hasAudioCandidates,
  sourceFrame,
  validateEditorDocument,
  valueAt,
} from "./document";

const vertexShader = `#version 300 es
in vec2 point; out vec2 uv;
void main(){uv=(point+1.0)*0.5;gl_Position=vec4(point,0,1);}`;
const fragmentShader = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 uv; out vec4 outputColor;
uniform sampler2D picture; uniform sampler2D curves; uniform sampler3D lut;
uniform vec2 viewport; uniform vec2 dimensions; uniform vec2 position;
uniform float scale; uniform float rotation; uniform float opacity;
uniform float exposure; uniform float contrast; uniform float saturation; uniform float temperature; uniform float blur;
uniform vec4 crop; uniform bool useLut; uniform int lutSize; uniform vec3 domainMin; uniform vec3 domainMax;
vec3 lookup(vec3 c){
 vec3 p=clamp((c-domainMin)/(domainMax-domainMin),0.0,1.0)*float(lutSize-1); ivec3 a=ivec3(floor(p)); ivec3 b=min(a+1,ivec3(lutSize-1)); vec3 f=fract(p);
 vec3 low=mix(mix(texelFetch(lut,ivec3(a.x,a.y,a.z),0).rgb,texelFetch(lut,ivec3(b.x,a.y,a.z),0).rgb,f.x),mix(texelFetch(lut,ivec3(a.x,b.y,a.z),0).rgb,texelFetch(lut,ivec3(b.x,b.y,a.z),0).rgb,f.x),f.y);
 vec3 high=mix(mix(texelFetch(lut,ivec3(a.x,a.y,b.z),0).rgb,texelFetch(lut,ivec3(b.x,a.y,b.z),0).rgb,f.x),mix(texelFetch(lut,ivec3(a.x,b.y,b.z),0).rgb,texelFetch(lut,ivec3(b.x,b.y,b.z),0).rgb,f.x),f.y);
 return mix(low,high,f.z);
}
void main(){
 vec2 p=(uv-0.5)*viewport-position; float c=cos(rotation),s=sin(rotation); p=mat2(c,-s,s,c)*p;
 float fit=min(viewport.x/dimensions.x,viewport.y/dimensions.y)*scale;
 vec2 q=p/(dimensions*fit)+0.5; q.y=1.0-q.y;
 if(q.x<crop.x||q.x>1.0-crop.y||q.y<crop.z||q.y>1.0-crop.w){outputColor=vec4(0);return;}
 vec4 color=vec4(0); vec2 stepSize=vec2(blur)/dimensions;
 for(int x=-1;x<=1;x++){for(int y=-1;y<=1;y++){color+=texture(picture,clamp(q+vec2(x,y)*stepSize,crop.xz,1.0-crop.yw))/9.0;}}
 vec3 rgb=color.rgb*exp2(exposure); rgb=(rgb-0.5)*contrast+0.5;
 float luma=dot(rgb,vec3(.2126,.7152,.0722)); rgb=mix(vec3(luma),rgb,saturation);rgb+=vec3(temperature*.1,0,-temperature*.1);
 rgb=vec3(texture(curves,vec2(clamp(rgb.r,0.0,1.0),.5)).r,texture(curves,vec2(clamp(rgb.g,0.0,1.0),.5)).g,texture(curves,vec2(clamp(rgb.b,0.0,1.0),.5)).b);
 if(useLut)rgb=lookup(rgb);outputColor=vec4(clamp(rgb,0.0,1.0),color.a*opacity);
}`;
interface Source {
  element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;
  texture: WebGLTexture;
  gain?: GainNode;
  node?: MediaElementAudioSourceNode;
}
function loadElement(artifact: StudioArtifact): Promise<HTMLVideoElement | HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const element = artifact.kind === "image" ? new Image() : document.createElement("video");
    element.crossOrigin = "anonymous";
    const timer = window.setTimeout(() => {
      cleanup();
      reject(
        new Error(
          t("Could not open {name}. Check that the media file is available.", {
            name: artifact.fileName,
          }),
        ),
      );
    }, 20000);
    const cleanup = () => {
      clearTimeout(timer);
      element.removeEventListener("error", failed);
      element.removeEventListener("loadeddata", ready);
      element.removeEventListener("load", ready);
    };
    const failed = () => {
      cleanup();
      reject(new Error(t("Could not decode {name}.", { name: artifact.fileName })));
    };
    const ready = () => {
      cleanup();
      resolve(element);
    };
    element.addEventListener("error", failed, { once: true });
    element.addEventListener(artifact.kind === "image" ? "load" : "loadeddata", ready, {
      once: true,
    });
    if (element instanceof HTMLVideoElement) {
      element.preload = "auto";
      element.playsInline = true;
      element.muted = true;
      element.preservesPitch = true;
    }
    element.src = artifactSrc(artifact);
  });
}
function shader(gl: WebGL2RenderingContext, type: number, text: string): WebGLShader {
  const result = gl.createShader(type);
  if (!result) throw new Error(t("Your device could not start the montage preview."));
  gl.shaderSource(result, text);
  gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(result);
    gl.deleteShader(result);
    throw new Error(error ?? t("Your device could not start the montage preview."));
  }
  return result;
}
function seekVideo(video: HTMLVideoElement, seconds: number): Promise<void> {
  const position = Math.max(
    0,
    Math.min(
      seconds,
      Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.001) : seconds,
    ),
  );
  if (Math.abs(video.currentTime - position) < 0.001) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener("seeked", done);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(t("A media file could not be positioned. Try opening it again.")));
    }, 10000);
    const done = () => {
      cleanup();
      resolve();
    };
    video.addEventListener("seeked", done, { once: true });
    try {
      video.currentTime = position;
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
/** One renderer for both the monitor and captureStream. All effects are applied
 * here, so export cannot accidentally omit a preview-only CSS effect. */
export class EditorCompositor {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private buffer: WebGLBuffer;
  private curveTexture: WebGLTexture;
  private lutTexture: WebGLTexture;
  private sources = new Map<string, Source>();
  private activeClips = new Set<string>();
  private curveCache = "";
  private lutCache: EditorClip["grade"]["lut"];
  private audio?: EditorAudio;
  private artifacts: StudioArtifact[] = [];
  private disposed = false;
  private generation = 0;
  private seekGeneration = 0;
  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    if (!gl)
      throw new Error(
        t("Your device does not support the montage preview. Try updating your graphics driver."),
      );
    this.gl = gl;
    const program = gl.createProgram(),
      buffer = gl.createBuffer(),
      curve = gl.createTexture(),
      lut = gl.createTexture();
    if (!program || !buffer || !curve || !lut)
      throw new Error(t("Your device could not start the montage preview."));
    this.program = program;
    this.buffer = buffer;
    this.curveTexture = curve;
    this.lutTexture = lut;
    const vert = shader(gl, gl.VERTEX_SHADER, vertexShader),
      frag = shader(gl, gl.FRAGMENT_SHADER, fragmentShader);
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(t("Your device could not start the montage preview."));
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL method, not a React hook.
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const point = gl.getAttribLocation(program, "point");
    gl.enableVertexAttribArray(point);
    gl.vertexAttribPointer(point, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(gl.getUniformLocation(program, "picture"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "curves"), 1);
    gl.uniform1i(gl.getUniformLocation(program, "lut"), 2);
    // WebGL requires every sampler, including a disabled LUT, to be complete.
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, lut);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, 2, 2, 2, 0, gl.RGB, gl.FLOAT, new Float32Array(24));
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }
  async prepare(doc: EditorDocument, artifacts: StudioArtifact[]): Promise<void> {
    this.artifacts = artifacts;
    const generation = ++this.generation;
    for (const clip of doc.clips) {
      if (this.disposed || generation !== this.generation) return;
      if (this.sources.has(clip.id) && clip.artifactId) continue;
      let element: Source["element"];
      if (clip.title !== undefined) {
        const title = document.createElement("canvas");
        title.width = doc.width;
        title.height = doc.height;
        const context = title.getContext("2d");
        if (!context) throw new Error(t("Could not draw your title."));
        context.fillStyle = "white";
        context.font = `${Math.round(doc.height / 14)}px sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        const lines = clip.title.split("\n");
        lines.forEach((line, i) => {
          context.fillText(
            line,
            doc.width / 2,
            doc.height / 2 + ((i - (lines.length - 1) / 2) * doc.height) / 11,
            doc.width * 0.9,
          );
        });
        element = title;
      } else {
        const artifact = artifacts.find((a) => a.id === clip.artifactId);
        if (!artifact)
          throw new Error(
            t("The media for {name} is missing. Choose another take.", { name: clip.name }),
          );
        element = await loadElement(artifact);
      }
      if (this.disposed || generation !== this.generation) {
        if (element instanceof HTMLVideoElement) {
          element.pause();
          element.removeAttribute("src");
          element.load();
        }
        return;
      }
      const old = this.sources.get(clip.id);
      if (old) this.releaseSource(old);
      this.activeClips.delete(clip.id);
      const texture = this.gl.createTexture();
      if (!texture) throw new Error(t("Your device could not start the montage preview."));
      this.sources.set(clip.id, { element, texture });
    }
    for (const [id, source] of this.sources)
      if (!doc.clips.some((c) => c.id === id)) {
        this.releaseSource(source);
        this.sources.delete(id);
        this.activeClips.delete(id);
      }
  }
  async enableAudio(doc: EditorDocument, capture = false): Promise<MediaStream | undefined> {
    if (!hasAudioCandidates(doc, this.artifacts)) {
      this.audio?.dispose();
      this.audio = undefined;
      return undefined;
    }
    if (!this.audio) this.audio = new EditorAudio();
    return this.audio.prepare(doc, this.artifacts, capture);
  }
  async startAudio(doc: EditorDocument, frame: number): Promise<number> {
    return this.audio ? this.audio.start(doc, frame) : performance.now();
  }
  async suspendAudio(): Promise<void> {
    await this.audio?.suspend();
  }
  async resumeAudio(): Promise<void> {
    await this.audio?.resume();
  }
  get audioWarnings(): string[] {
    return this.audio?.warnings ?? [];
  }
  async seek(doc: EditorDocument, frame: number): Promise<void> {
    const generation = ++this.seekGeneration;
    this.pause();
    await Promise.all(
      doc.clips.map(async (clip) => {
        const source = this.sources.get(clip.id);
        if (
          !source ||
          !(source.element instanceof HTMLVideoElement) ||
          frame < clip.start ||
          frame >= clip.start + clip.duration
        )
          return;
        const video = source.element,
          seconds = sourceFrame(clip, frame - clip.start) / fps(doc);
        if (Math.abs(video.currentTime - seconds) < 0.001) return;
        await seekVideo(video, seconds);
      }),
    );
    if (!this.disposed && generation === this.seekGeneration) this.draw(doc, frame, false);
  }
  async prepareRecordCuts(doc: EditorDocument): Promise<void> {
    await Promise.all(
      doc.clips.map(async (clip) => {
        const source = this.sources.get(clip.id);
        if (!source || !(source.element instanceof HTMLVideoElement)) return;
        source.element.pause();
        await seekVideo(source.element, sourceFrame(clip, 0) / fps(doc));
      }),
    );
  }
  async drawRecorded(
    doc: EditorDocument,
    frame: number,
    onWait?: (waiting: boolean) => Promise<void>,
  ): Promise<void> {
    // A newly active or trimmed source needs a decoded frame before the canvas
    // is captured. Setting currentTime and drawing in the same tick can upload
    // the previous clip's frame (or a black frame) at the cut.
    const pending = doc.clips.flatMap((clip) => {
      if (frame < clip.start || frame >= clip.start + clip.duration) return [];
      const source = this.sources.get(clip.id);
      if (!source || !(source.element instanceof HTMLVideoElement)) return [];
      const video = source.element;
      const target = sourceFrame(clip, frame - clip.start) / fps(doc);
      if (Math.abs(video.currentTime - target) <= (this.activeClips.has(clip.id) ? 0.15 : 0.001))
        return [];
      return [{ video, target }];
    });
    if (pending.length) await onWait?.(true);
    await Promise.all(
      pending.map(async ({ video, target }) => {
        video.pause();
        await seekVideo(video, target);
      }),
    );
    if (!this.disposed) this.draw(doc, frame, true, true);
    if (pending.length) await onWait?.(false);
  }
  draw(doc: EditorDocument, frame: number, playing: boolean, recording = false): void {
    if (this.disposed) return;
    const gl = this.gl;
    if (this.canvas.width !== doc.width || this.canvas.height !== doc.height) {
      this.canvas.width = doc.width;
      this.canvas.height = doc.height;
    }
    gl.viewport(0, 0, doc.width, doc.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL method, not a React hook.
    gl.useProgram(this.program);
    const active = new Set<string>();
    // Later picture tracks overlay earlier ones.
    for (const track of doc.tracks)
      for (const clip of doc.clips.filter((c) => c.trackId === track.id)) {
        const source = this.sources.get(clip.id);
        if (!source || frame < clip.start || frame >= clip.start + clip.duration) continue;
        active.add(clip.id);
        const local = frame - clip.start;
        if (source.element instanceof HTMLVideoElement) {
          const media = source.element;
          if (source.gain)
            source.gain.gain.value =
              track.muted || track.hidden
                ? 0
                : valueAt(clip.properties.volume, local, 1) * clipFade(clip, local);
          if (playing) {
            const target = sourceFrame(clip, local) / fps(doc);
            media.playbackRate = Math.max(
              0.0625,
              Math.min(16, valueAt(clip.properties.speed, local, 1)),
            );
            if (
              recording
                ? Math.abs(media.currentTime - target) >
                  (this.activeClips.has(clip.id) ? 0.15 : 0.001)
                : !this.activeClips.has(clip.id) || Math.abs(media.currentTime - target) > 0.15
            )
              media.currentTime = Math.min(target, Math.max(0, media.duration - 0.001));
            if (media.paused) void media.play().catch(() => {});
          }
        }
        if (track.kind === "audio" || track.hidden) continue;
        const element = source.element;
        const width =
          element instanceof HTMLVideoElement
            ? element.videoWidth
            : element instanceof HTMLImageElement
              ? element.naturalWidth
              : element.width;
        const height =
          element instanceof HTMLVideoElement
            ? element.videoHeight
            : element instanceof HTMLImageElement
              ? element.naturalHeight
              : element.height;
        if (!width || !height) continue;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, source.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, element);
        const uniform = (name: string) => gl.getUniformLocation(this.program, name);
        gl.uniform2f(uniform("viewport"), doc.width, doc.height);
        gl.uniform2f(uniform("dimensions"), width, height);
        gl.uniform2f(
          uniform("position"),
          valueAt(clip.properties.x, local),
          -valueAt(clip.properties.y, local),
        );
        gl.uniform1f(uniform("scale"), valueAt(clip.properties.scale, local, 1));
        gl.uniform1f(
          uniform("rotation"),
          (valueAt(clip.properties.rotation, local) * Math.PI) / 180,
        );
        gl.uniform1f(uniform("opacity"), clipOpacity(clip, local));
        for (const key of ["exposure", "contrast", "saturation", "temperature", "blur"] as const)
          gl.uniform1f(uniform(key), clip.grade[key]);
        gl.uniform4f(
          uniform("crop"),
          clip.crop.left,
          clip.crop.right,
          clip.crop.top,
          clip.crop.bottom,
        );
        this.setCurves(clip);
        this.setLut(clip);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    for (const [id, source] of this.sources)
      if (!active.has(id) && source.element instanceof HTMLVideoElement) {
        source.element.pause();
        if (source.gain) source.gain.gain.value = 0;
      }
    this.activeClips = playing ? active : new Set();
  }
  private setCurves(clip: EditorClip) {
    const gl = this.gl,
      curves = clip.grade.curves,
      key = JSON.stringify(curves);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTexture);
    if (key === this.curveCache) return;
    this.curveCache = key;
    const sample = (points: number[], x: number) => {
      const at = Math.max(0, Math.min(1, x)) * (points.length - 1),
        i = Math.min(points.length - 2, Math.floor(at));
      return points[i] + (points[i + 1] - points[i]) * (at - i);
    };
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      for (const [channel, name] of (["red", "green", "blue"] as const).entries())
        data[i * 4 + channel] = Math.round(
          255 * Math.max(0, Math.min(1, sample(curves[name], sample(curves.master, i / 255)))),
        );
      data[i * 4 + 3] = 255;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  private setLut(clip: EditorClip) {
    const gl = this.gl,
      lut = clip.grade.lut;
    gl.uniform1i(gl.getUniformLocation(this.program, "useLut"), lut ? 1 : 0);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTexture);
    if (!lut) return;
    if (this.lutCache !== lut) {
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.RGB32F,
        lut.size,
        lut.size,
        lut.size,
        0,
        gl.RGB,
        gl.FLOAT,
        new Float32Array(lut.values),
      );
      this.lutCache = lut;
    }
    gl.uniform1i(gl.getUniformLocation(this.program, "lutSize"), lut.size);
    gl.uniform3fv(gl.getUniformLocation(this.program, "domainMin"), lut.domainMin);
    gl.uniform3fv(gl.getUniformLocation(this.program, "domainMax"), lut.domainMax);
  }
  pause() {
    this.activeClips.clear();
    this.audio?.pause();
    for (const source of this.sources.values())
      if (source.element instanceof HTMLVideoElement) source.element.pause();
  }
  private releaseSource(source: Source) {
    source.node?.disconnect();
    source.gain?.disconnect();
    this.gl.deleteTexture(source.texture);
    if (source.element instanceof HTMLVideoElement) {
      source.element.pause();
      source.element.removeAttribute("src");
      source.element.load();
    }
  }
  dispose() {
    this.disposed = true;
    this.pause();
    for (const source of this.sources.values()) this.releaseSource(source);
    this.sources.clear();
    this.audio?.dispose();
    this.gl.deleteTexture(this.curveTexture);
    this.gl.deleteTexture(this.lutTexture);
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteProgram(this.program);
  }
}

export async function recordEditor(
  doc: EditorDocument,
  artifacts: StudioArtifact[],
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<{ blob: Blob; extension: string; warnings: string[] }> {
  const problems = validateEditorDocument(doc);
  if (problems.length) throw new Error(problems.join("\n"));
  const frames = durationFrames(doc);
  if (!frames) throw new Error(t("Add a clip before exporting your montage."));
  const format = pickRecorderMime();
  if (!format)
    throw new Error(
      t("Your device cannot record this montage. Export the editable montage instead."),
    );
  const canvas = document.createElement("canvas"),
    renderer = new EditorCompositor(canvas);
  let stream: MediaStream | undefined;
  try {
    await renderer.prepare(doc, artifacts);
    await renderer.seek(doc, 0);
    await renderer.prepareRecordCuts(doc);
    const audio = await renderer.enableAudio(doc, true);
    stream = canvas.captureStream(fps(doc));
    audio?.getAudioTracks().forEach((track) => {
      stream?.addTrack(track);
    });
    const recorder = new MediaRecorder(stream, {
      mimeType: format.mimeType,
      videoBitsPerSecond: 12_000_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    await new Promise<void>((resolve, reject) => {
      let raf = 0;
      let settled = false;
      let start = performance.now();
      let pausedAt = 0;
      const cleanup = () => {
        cancelAnimationFrame(raf);
        options.signal?.removeEventListener("abort", abort);
        document.removeEventListener("visibilitychange", visibility);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (recorder.state !== "inactive") recorder.stop();
        reject(error);
      };
      const abort = () => fail(new Error(t("Export cancelled. Your montage is saved.")));
      const visibility = () => {
        if (document.hidden)
          fail(
            new Error(
              t(
                "Export stopped while the app was hidden. Keep it open and export again. Your montage is saved.",
              ),
            ),
          );
      };
      recorder.onerror = () =>
        fail(new Error(t("The video export failed. Your montage is saved; try exporting again.")));
      recorder.onstop = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      document.addEventListener("visibilitychange", visibility);
      if (options.signal?.aborted) {
        abort();
        return;
      }
      const tick = async () => {
        try {
          if (settled) return;
          const frame = Math.max(0, ((performance.now() - start) * fps(doc)) / 1000);
          if (frame >= frames) {
            recorder.stop();
            return;
          }
          await renderer.drawRecorded(doc, frame, async (waiting) => {
            if (waiting) {
              pausedAt = performance.now();
              if (recorder.state === "recording") recorder.pause();
              await renderer.suspendAudio();
            } else {
              await renderer.resumeAudio();
              start += performance.now() - pausedAt;
              if (recorder.state === "paused") recorder.resume();
            }
          });
          if (settled) return;
          options.onProgress?.(frame / frames);
          raf = requestAnimationFrame(() => void tick());
        } catch (error) {
          fail(error instanceof Error ? error : new Error(messageFromError(error)));
        }
      };
      void renderer
        .startAudio(doc, 0)
        .then((audioStart) => {
          if (settled) return;
          start = audioStart;
          const wait = () => {
            if (performance.now() < start) {
              raf = requestAnimationFrame(wait);
              return;
            }
            recorder.start(1000);
            void tick();
          };
          wait();
        })
        .catch(fail);
    });
    options.onProgress?.(1);
    return {
      blob: new Blob(chunks, { type: format.mimeType }),
      extension: format.extension,
      warnings: renderer.audioWarnings,
    };
  } finally {
    renderer.dispose();
    stream?.getTracks().forEach((track) => {
      track.stop();
    });
  }
}
