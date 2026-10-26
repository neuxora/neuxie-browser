import "$styles/global.css";
import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import type { VoiceStatusV1 } from "$shared/ipc/bindings";
import VoiceRowStage from "./VoiceRowStage.svelte";

const native = vi.hoisted(() => ({
  status: vi.fn<() => Promise<VoiceStatusV1>>(),
  engine: vi.fn<(engine: string | null) => Promise<VoiceStatusV1>>(),
  language: vi.fn<(language: string | null) => Promise<VoiceStatusV1>>(),
}));

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    voiceStatus: native.status,
    voiceChooseEngine: native.engine as never,
    voiceChooseLanguage: native.language,
  });
});

afterEach(() => vi.clearAllMocks());

const status = (rest: Partial<VoiceStatusV1> = {}): VoiceStatusV1 => ({
  version: 1,
  engines: ["on_device", "zephium", "open_ai"],
  chosen: null,
  effective: "on_device",
  language: null,
  languages: ["en-US", "pl-PL"],
  on_device: "en_US",
  microphone: "granted",
  ...rest,
});

const shots = "../../../../../target/work-voice";
const settle = () => new Promise((done) => setTimeout(done, 450));

async function shoot(name: string) {
  for (const theme of ["dark", "light"]) {
    document.documentElement.dataset.theme = theme;
    await settle();
    await page.screenshot({ path: `${shots}/settings-${name}-${theme}.png` });
  }
  document.documentElement.dataset.theme = "dark";
}

test("Voice lists only usable engines and says where audio goes, in both themes", async () => {
  await page.viewport(900, 420);
  native.status.mockResolvedValue(status());
  const screen = await render(VoiceRowStage);
  await expect
    .element(page.getByText("Private and works offline. Your voice never leaves this device."))
    .toBeVisible();
  await shoot("on-device");

  native.language.mockResolvedValue(
    status({ language: "pl-PL", on_device: null, effective: "zephium" }),
  );
  await page.getByRole("button", { name: "Language" }).click();
  await page.getByRole("option", { name: "Polish (Poland)" }).click();
  expect(native.language).toHaveBeenCalledWith("pl-PL");
  await expect
    .element(
      page.getByText(
        "This device can’t recognize Polish (Poland), so dictation in it uses Neuxie AI.",
      ),
    )
    .toBeVisible();
  await shoot("fallback");

  native.engine.mockResolvedValue(status({ chosen: "open_ai", effective: "open_ai" }));
  await page.getByRole("button", { name: "Dictation" }).click();
  await expect
    .element(page.getByRole("option", { name: "Groq · your key" }))
    .not.toBeInTheDocument();
  await page.getByRole("option", { name: "OpenAI · your key" }).click();
  expect(native.engine).toHaveBeenCalledWith("open_ai");
  await expect
    .element(page.getByText("While you dictate, audio goes to OpenAI and nowhere else."))
    .toBeVisible();
  await screen.unmount();
});

test("with no engine on Windows the row says how to set one up", async () => {
  await page.viewport(900, 420);
  native.status.mockResolvedValue(
    status({ engines: [], effective: null, on_device: null, languages: ["en-US"] }),
  );
  const screen = await render(VoiceRowStage);
  await expect
    .element(page.getByText("Sign in to Neuxie AI or add an OpenAI or Groq key to dictate."))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Dictation" })).toBeDisabled();
  await shoot("none");
  await screen.unmount();
});
