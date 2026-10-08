import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { zipEntries } from "../../website/src/client/documents/unzip";
import {
  type PowerPointApi,
  powerPointHost,
  toBase64,
} from "../../office-addins/src/powerpoint/host";
import { PowerPointPane } from "../../office-addins/src/powerpoint/PowerPointPane";
import { deckBytes, slideDrafting } from "../../office-addins/src/powerpoint/slides";
import { OFFICE } from "../../office-addins/src/words";
import { fakeEngine, lastUser } from "./office-addins-fakes";
import { text, toolCall } from "./website-client-fakes";

const SLIDES = {
  kind: "pptx",
  title: "Quarter",
  content: {
    slides: [
      { layout: "title", title: "Quarter review", subtitle: "Q3" },
      { layout: "bullets", title: "Numbers", bullets: ["Revenue up", "Costs flat"] },
    ],
  },
};

function fakePowerPoint(selected: string[] = []) {
  const inserted: { base64: string; options: unknown }[] = [];
  const powerPoint: PowerPointApi = {
    async run(batch) {
      return batch({
        presentation: {
          insertSlidesFromBase64: (base64, options) => {
            inserted.push({ base64, options });
          },
          getSelectedSlides: () => ({
            items: selected.map((id) => ({ id })),
            load: () => undefined,
          }),
        },
        sync: async () => undefined,
      });
    },
  };
  return { powerPoint, inserted };
}

describe("slides drafted with make_document", () => {
  it("keeps the slides as a proposal and answers the model in Rust's words", async () => {
    const drafting = slideDrafting();
    const reply = await drafting.addition.run?.("make_document", SLIDES, {
      chatId: null,
      temporary: true,
      question: "",
    });
    expect(reply).toBe(OFFICE.powerpoint.proposed);
    expect(drafting.drafted()?.slides.map((slide) => slide.title)).toEqual([
      "Quarter review",
      "Numbers",
    ]);
    const other = slideDrafting();
    expect(
      await other.addition.run?.(
        "make_document",
        { ...SLIDES, kind: "docx" },
        { chatId: null, temporary: true, question: "" },
      ),
    ).toBe(OFFICE.powerpoint.refused);
    expect(other.drafted()).toBeNull();
  });

  it("packages a deck PowerPoint can insert", async () => {
    const drafting = slideDrafting();
    await drafting.addition.run?.("make_document", SLIDES, {
      chatId: null,
      temporary: true,
      question: "",
    });
    const bytes = await deckBytes(drafting.drafted()?.request as never);
    const names = zipEntries(bytes).map((entry) => entry.name);
    expect(names).toContain("ppt/slides/slide2.xml");
    expect(atob(toBase64(bytes)).length).toBe(bytes.length);
  });
});

describe("the PowerPoint pane", () => {
  it("lists the drafted slides and adds them only on confirmation, after the selected slide", async () => {
    const { powerPoint, inserted } = fakePowerPoint(["256#", "257#"]);
    let turn = 0;
    const { engine, calls } = fakeEngine(() =>
      turn++ === 0 ? toolCall("make_document", SLIDES) : text("Two slides are ready."),
    );
    render(
      <PowerPointPane host={powerPointHost(powerPoint, true)} engine={engine} canInsert={true} />,
    );
    const [request, note] = screen.getAllByRole("textbox");
    await userEvent.type(request, "A quarter review");
    await userEvent.type(note, "Revenue up, costs flat");
    await userEvent.click(screen.getByRole("button", { name: "Draft the slides" }));
    await screen.findByText("Quarter review");
    expect(screen.getByText("Costs flat")).toBeTruthy();
    const first = calls[0].body;
    expect((first.messages as { content: string }[])[0].content).toContain(
      OFFICE.powerpoint.section,
    );
    expect(lastUser(first)).toContain("<note>\nRevenue up, costs flat\n</note>");
    expect(inserted).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Add 2 slides" }));
    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(inserted[0].options).toEqual({
      formatting: "UseDestinationTheme",
      targetSlideId: "257#",
    });
    await screen.findByText("Added 2 slides to the presentation.");
  });

  it("says so when the model drafted nothing", async () => {
    const { powerPoint } = fakePowerPoint();
    const { engine } = fakeEngine(() => text("I need more detail."));
    render(
      <PowerPointPane host={powerPointHost(powerPoint, false)} engine={engine} canInsert={true} />,
    );
    await userEvent.type(screen.getAllByRole("textbox")[0], "slides");
    await userEvent.click(screen.getByRole("button", { name: "Draft the slides" }));
    await screen.findByText(/No slides were drafted/);
  });
});
