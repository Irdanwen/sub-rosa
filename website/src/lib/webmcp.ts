type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean };
  execute: (input: unknown) => unknown;
};
type Context = {
  registerTool: (tool: Tool, options: { signal: AbortSignal }) => void | Promise<void>;
};

/** Navigation only. No tool receives credentials, decrypts data or authorizes an app. */
export function registerAccountNavigation(navigate: (path: string) => void) {
  const context = (document as Document & { modelContext?: Context }).modelContext;
  if (!context) return () => {};
  const controller = new AbortController();
  const sections = ["overview", "provider", "usage", "devices", "security"];
  try {
    void Promise.resolve(
      context.registerTool(
        {
          name: "open_account_section",
          description:
            "Open a section of the Sub Rosa account interface. This only navigates and does not sign in, decrypt a vault or change account data.",
          inputSchema: {
            type: "object",
            properties: { section: { type: "string", enum: sections } },
            required: ["section"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false },
          execute(input) {
            if (
              !input ||
              typeof input !== "object" ||
              Object.keys(input).length !== 1 ||
              !("section" in input) ||
              typeof input.section !== "string" ||
              !sections.includes(input.section)
            )
              throw new Error("Invalid account section");
            const path = input.section === "overview" ? "/account" : `/account/${input.section}`;
            navigate(path);
            return { path, action: "navigation_started" };
          },
        },
        { signal: controller.signal },
      ),
    ).catch(() => {
      /* Optional browser capability. */
    });
  } catch {
    /* Unsupported experimental browser API. */
  }
  return () => controller.abort();
}
