import { describe, expect, it } from "vitest";
import {
  DEFAULT_FRAME_RATE,
  FRAME_RATES,
  framesPerSecond,
  srtTimecode,
  type TimelineCut,
  timelineProblems,
  toFcpxml,
  toFrames,
  toSrt,
  toTimeline,
  toXmeml,
} from "../lib/studio/timeline";

function cut(overrides: Partial<TimelineCut> = {}): TimelineCut {
  return {
    name: "Neon alley",
    frameRate: FRAME_RATES["25"],
    width: 1920,
    height: 1080,
    clips: [
      {
        name: "Shot 1",
        href: "file:///g/one.mp4",
        inSeconds: 0,
        outSeconds: 4,
        sourceDurationSeconds: 5,
        hasAudio: true,
      },
      {
        name: "Shot 2",
        href: "file:///g/two.mp4",
        inSeconds: 0.5,
        outSeconds: 3.5,
        sourceDurationSeconds: 5,
        hasAudio: true,
      },
    ],
    ...overrides,
  };
}

const parse = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");
const wellFormed = (xml: string) => parse(xml).getElementsByTagName("parsererror").length === 0;

describe("the timebase", () => {
  it("keeps NTSC rates exact instead of writing 29.97 anywhere", () => {
    // 29.97 is 30000/1001. A document that says 29.97 drifts about a second an
    // hour, which is invisible in a test and obvious in a feature.
    expect(framesPerSecond(FRAME_RATES["29.97"])).toBeCloseTo(29.97002997, 6);
    const xml = toFcpxml(cut({ frameRate: FRAME_RATES["29.97"] }));
    expect(xml).toContain('frameDuration="1001/30000s"');
    expect(xml).not.toContain("29.97");
  });

  it("rounds to whole frames, never to a fraction of one", () => {
    expect(toFrames(1 / 3, FRAME_RATES["25"])).toBe(8);
    expect(toFrames(-4, FRAME_RATES["25"])).toBe(0);
    expect(toFrames(Number.NaN, FRAME_RATES["25"])).toBe(0);
  });

  it("carries a rounded millisecond into the second rather than printing ,1000", () => {
    expect(srtTimecode(0)).toBe("00:00:00,000");
    expect(srtTimecode(3661.5)).toBe("01:01:01,500");
    expect(srtTimecode(1.9999)).toBe("00:00:02,000");
    expect(srtTimecode(-3)).toBe("00:00:00,000");
  });
});

describe("what cannot be exported", () => {
  it("names an unmeasured clip instead of writing zeroed times", () => {
    // The single most common cause of a rejected file: a clip whose duration
    // was never measured, so every time on it is zero.
    const problems = timelineProblems(
      cut({
        clips: [
          {
            name: "Shot 1",
            href: "file:///g/one.mp4",
            inSeconds: 0,
            outSeconds: 4,
            sourceDurationSeconds: Number.NaN,
            hasAudio: true,
          },
        ],
      }),
    );
    expect(problems).toContain("Shot 1 has no measured duration yet.");
  });

  it("catches the trims an editor cannot mean", () => {
    const problems = timelineProblems(
      cut({
        clips: [
          {
            name: "Backwards",
            href: "file:///g/a.mp4",
            inSeconds: 3,
            outSeconds: 1,
            sourceDurationSeconds: 5,
            hasAudio: false,
          },
          {
            name: "Overrun",
            href: "file:///g/b.mp4",
            inSeconds: 0,
            outSeconds: 9,
            sourceDurationSeconds: 5,
            hasAudio: false,
          },
          {
            name: "Sliver",
            href: "file:///g/c.mp4",
            inSeconds: 0,
            outSeconds: 0.001,
            sourceDurationSeconds: 5,
            hasAudio: false,
          },
        ],
      }),
    );
    expect(problems).toContain("Backwards is trimmed to nothing.");
    expect(problems).toContain("Overrun is trimmed past the end of its file.");
    expect(problems).toContain("Sliver is shorter than one frame.");
  });

  it("refuses rather than writing an empty sequence", () => {
    expect(() => toFcpxml(cut({ clips: [] }))).toThrow(/no shots/);
    expect(() => toXmeml(cut({ clips: [] }))).toThrow(/no shots/);
  });
});

describe("FCPXML", () => {
  it("is well formed and every ref resolves", () => {
    const xml = toFcpxml(cut());
    expect(wellFormed(xml)).toBe(true);
    const doc = parse(xml);
    const ids = new Set(
      Array.from(doc.querySelectorAll("resources > *")).map((node) => node.getAttribute("id")),
    );
    for (const clip of Array.from(doc.querySelectorAll("asset-clip"))) {
      expect(ids.has(clip.getAttribute("ref"))).toBe(true);
    }
    // A dangling `format` is the other half of the same failure.
    for (const node of Array.from(doc.querySelectorAll("[format]"))) {
      expect(ids.has(node.getAttribute("format"))).toBe(true);
    }
  });

  it("butts every shot against the last one, in frames", () => {
    const doc = parse(toFcpxml(cut()));
    const spine = Array.from(doc.querySelectorAll("spine > asset-clip"));
    expect(spine.map((node) => node.getAttribute("offset"))).toEqual(["0/25s", "100/25s"]);
    expect(spine.map((node) => node.getAttribute("duration"))).toEqual(["100/25s", "75/25s"]);
    // The second shot starts inside its source, not at zero.
    expect(spine[1]?.getAttribute("start")).toBe("13/25s");
    expect(doc.querySelector("sequence")?.getAttribute("duration")).toBe("175/25s");
  });

  it("declares one asset per file however many times it is used", () => {
    const doc = parse(
      toFcpxml(
        cut({
          clips: [
            {
              name: "A",
              href: "file:///g/one.mp4",
              inSeconds: 0,
              outSeconds: 2,
              sourceDurationSeconds: 5,
              hasAudio: true,
            },
            {
              name: "A again",
              href: "file:///g/one.mp4",
              inSeconds: 2,
              outSeconds: 4,
              sourceDurationSeconds: 5,
              hasAudio: true,
            },
          ],
        }),
      ),
    );
    expect(doc.querySelectorAll("asset").length).toBe(1);
    // Reimporting the same cut must not duplicate the media in the library, so
    // the uid is derived from the file rather than generated.
    const uid = doc.querySelector("asset")?.getAttribute("uid");
    expect(uid).toMatch(/^[0-9A-F]{8}$/);
    expect(toFcpxml(cut())).toContain(
      `uid="${parse(toFcpxml(cut())).querySelector("asset")?.getAttribute("uid")}"`,
    );
  });

  it("positions a connected sound in its parent's time, not the timeline's", () => {
    // The parent starts one second into its source, so a sound at 2 s on the
    // timeline sits at 3 s in the parent's coordinates. Getting this wrong puts
    // the dialogue somewhere plausible and wrong.
    const doc = parse(
      toFcpxml(
        cut({
          clips: [
            {
              name: "Shot 1",
              href: "file:///g/one.mp4",
              inSeconds: 1,
              outSeconds: 6,
              sourceDurationSeconds: 8,
              hasAudio: true,
            },
          ],
          audio: {
            dialogue: [
              {
                name: "Line 1",
                href: "file:///g/line1.mp3",
                inSeconds: 0,
                outSeconds: 1.2,
                sourceDurationSeconds: 1.2,
                atSeconds: 2,
              },
            ],
            music: [
              {
                name: "Score",
                href: "file:///g/score.mp3",
                inSeconds: 0,
                outSeconds: 5,
                sourceDurationSeconds: 30,
                atSeconds: 0,
                gain: 0.5,
              },
            ],
          },
        }),
      ),
    );
    const connected = Array.from(doc.querySelectorAll("spine > asset-clip > asset-clip"));
    expect(connected.length).toBe(2);
    const line = connected.find((node) => node.getAttribute("name") === "Line 1");
    expect(line?.getAttribute("lane")).toBe("-1");
    expect(line?.getAttribute("offset")).toBe("75/25s");
    expect(line?.getAttribute("audioRole")).toBe("dialogue");
    const score = connected.find((node) => node.getAttribute("name") === "Score");
    expect(score?.getAttribute("lane")).toBe("-3");
    expect(score?.getAttribute("offset")).toBe("25/25s");
    // Half gain is about -6 dB, and silence must not become -Infinity.
    expect(score?.querySelector("adjust-volume")?.getAttribute("amount")).toBe("-6.02dB");
  });

  it("writes a silent lane as a floor, never as -Infinity", () => {
    const xml = toFcpxml(
      cut({
        audio: {
          music: [
            {
              name: "Muted",
              href: "file:///g/m.mp3",
              inSeconds: 0,
              outSeconds: 2,
              sourceDurationSeconds: 2,
              atSeconds: 0,
              gain: 0,
            },
          ],
        },
      }),
    );
    expect(xml).toContain('amount="-96dB"');
    expect(xml).not.toContain("Infinity");
  });

  it("escapes a name that came out of a prompt", () => {
    const xml = toFcpxml(cut({ name: 'Rain & "steam" <take 2>' }));
    expect(wellFormed(xml)).toBe(true);
    expect(xml).toContain("Rain &amp; &quot;steam&quot; &lt;take 2&gt;");
  });
});

describe("xmeml", () => {
  it("is well formed and keeps timeline length equal to source length", () => {
    const xml = toXmeml(cut());
    expect(wellFormed(xml)).toBe(true);
    const doc = parse(xml);
    for (const item of Array.from(doc.querySelectorAll("clipitem"))) {
      const value = (tag: string) => Number(item.querySelector(tag)?.textContent);
      // start/end are the timeline, in/out are the source. They must describe
      // the same length, or the edit imports at plausible but wrong lengths.
      expect(value("end") - value("start")).toBe(value("out") - value("in"));
    }
  });

  it("declares a file once and references it afterwards", () => {
    const doc = parse(
      toXmeml(
        cut({
          clips: [
            {
              name: "A",
              href: "file:///g/one.mp4",
              inSeconds: 0,
              outSeconds: 2,
              sourceDurationSeconds: 5,
              hasAudio: true,
            },
            {
              name: "A again",
              href: "file:///g/one.mp4",
              inSeconds: 2,
              outSeconds: 4,
              sourceDurationSeconds: 5,
              hasAudio: true,
            },
          ],
        }),
      ),
    );
    const files = Array.from(doc.querySelectorAll("file"));
    expect(files.length).toBe(2);
    expect(files.filter((file) => file.querySelector("pathurl")).length).toBe(1);
    expect(files[1]?.getAttribute("id")).toBe(files[0]?.getAttribute("id"));
  });

  it("carries a lane's gain as the level effect Premiere expects", () => {
    const doc = parse(
      toXmeml(
        cut({
          audio: {
            music: [
              {
                name: "Score",
                href: "file:///g/score.mp3",
                inSeconds: 0,
                outSeconds: 4,
                sourceDurationSeconds: 30,
                atSeconds: 0,
                gain: 0.5,
              },
            ],
          },
        }),
      ),
    );
    expect(doc.querySelector("audio track clipitem effectid")?.textContent).toBe("audiolevels");
    expect(doc.querySelector("audio track clipitem parameter value")?.textContent).toBe("0.5");
  });

  it("omits the audio tracks when there is no sound to place", () => {
    // A source file still declares its own audio characteristics inside
    // <file><media>; what must be absent is the sequence's audio section.
    const doc = parse(toXmeml(cut()));
    expect(doc.querySelector("sequence > media > audio")).toBeNull();
    expect(doc.querySelector("sequence > media > video > track")).not.toBeNull();
  });
});

describe("subtitles", () => {
  it("writes a sidecar rather than needing a burn-in", () => {
    expect(
      toSrt([
        { atSeconds: 0, untilSeconds: 2.5, text: "  Get in.  " },
        { atSeconds: 2.5, untilSeconds: 4, text: "Two lines\nlike this" },
        { atSeconds: 4, untilSeconds: 5, text: "   " },
        { atSeconds: 6, untilSeconds: 6, text: "zero length" },
      ]),
    ).toBe(
      "1\n00:00:00,000 --> 00:00:02,500\nGet in.\n\n" +
        "2\n00:00:02,500 --> 00:00:04,000\nTwo lines\nlike this\n",
    );
  });
});

describe("toTimeline", () => {
  it("routes to the dialect that was asked for", () => {
    expect(toTimeline(cut(), "fcpxml")).toContain("<fcpxml");
    expect(toTimeline(cut(), "xmeml")).toContain("<xmeml");
  });

  it("defaults to a rate that is not NTSC, because a guess that drifts is worse", () => {
    expect(DEFAULT_FRAME_RATE).toEqual({ base: 30, ntsc: false });
  });
});
