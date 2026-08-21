import { describe, expect, it } from "vitest";
import { pricingLabel } from "../components/settings/ModelPickerDialog";
import type { VeniceModelDto } from "../lib/tauri";

function tokenModel(over: Partial<VeniceModelDto> = {}): VeniceModelDto {
  return {
    provider: "venice",
    id: "zai-org-glm-5-2",
    name: "GLM 5.2",
    modelType: "text",
    traits: [],
    capabilities: [],
    priceUnit: "tokens",
    priceDescription: "",
    inputCreditsPerMillionTokens: 1400,
    outputCreditsPerMillionTokens: 5500,
    ...over,
  } as VeniceModelDto;
}

describe("pricingLabel", () => {
  // The picker's price line is where a user reads a rate before choosing a
  // model, and on a warm conversation the cache rate is what most of the prompt
  // actually costs. The shipped default: $1.40 against $0.26.
  it("names the cache rate next to the input rate", () => {
    const label = pricingLabel(tokenModel({ cacheInputCreditsPerMillionTokens: 260 }));

    expect(label).toBe("$1.40 input / $5.50 output per 1M tokens ($0.26 cached input)");
  });

  // Most of the catalogue publishes no cache rate, and those models bill cached
  // tokens like input. Their line must read exactly as it did before.
  it("says nothing for a model that publishes no cache rate", () => {
    const label = pricingLabel(tokenModel());

    expect(label).toBe("$1.40 input / $5.50 output per 1M tokens");
  });

  // A cache rate is up to ten times smaller than the input rate it discounts,
  // so two decimals would tell the user a cheap model caches for nothing.
  it("keeps a sub-cent cache rate legible", () => {
    const label = pricingLabel(
      tokenModel({
        inputCreditsPerMillionTokens: 10,
        outputCreditsPerMillionTokens: 40,
        cacheInputCreditsPerMillionTokens: 3,
      }),
    );

    expect(label).toBe("$0.01 input / $0.04 output per 1M tokens ($0.003 cached input)");
  });
});
