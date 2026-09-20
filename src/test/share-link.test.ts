import { describe, expect, it } from "vitest";
// The website has no suite of its own: it is checked by `tsc` and a build. This
// one parser is worth more than that, because it is the gate between a URL a
// stranger controls and a decryption key, so it is exercised from here.
import { readShareLink } from "../../website/src/lib/share";

const id = "0192f0aa-1111-7222-8333-444455556666";
const key = "A".repeat(43);

describe("readShareLink", () => {
  it("reads the identifier from the path and the key from the fragment", () => {
    const link = readShareLink(`/s/${id}`, `#k=${key}`);
    expect(link?.id).toBe(id);
    expect(link?.key.byteLength).toBe(32);
  });

  it("refuses anything that is not one share identifier", () => {
    for (const path of [
      `/s/${id}/extra`,
      "/s/not-a-uuid",
      `/share/${id}`,
      `/s/${id}?k=${key}`,
      "/s/",
    ])
      expect(readShareLink(path, `#k=${key}`)).toBeNull();
  });

  it("refuses a fragment that is not a 256 bit key", () => {
    for (const hash of [
      "",
      "#",
      "#k=",
      `#key=${key}`,
      "#k=short",
      `#k=${"A".repeat(86)}`,
      "#k=%%%",
    ])
      expect(readShareLink(`/s/${id}`, hash)).toBeNull();
  });

  it("accepts the identifier in either case and answers in one", () => {
    expect(readShareLink(`/s/${id.toUpperCase()}`, `#k=${key}`)?.id).toBe(id);
  });
});
