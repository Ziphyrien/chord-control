import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "vite-plus";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { chromium, expect } from "@playwright/test";

// No application config, theme stylesheet, backend, or build artifacts are required.
test(
  "portable Bits components preserve bindings, keyboard behavior and modal focus",
  { timeout: 45000 },
  async () => {
    const fixture = fileURLToPath(new URL("./InteractiveFixture.svelte", import.meta.url));
    const bundle = await build({
      configFile: false,
      logLevel: "error",
      plugins: [
        {
          name: "ui-browser-fixture",
          resolveId(id) {
            if (id === "virtual:ui-browser-fixture") return id;
          },
          load(id) {
            if (id === "virtual:ui-browser-fixture")
              return `import { mount } from "svelte"; import Fixture from ${JSON.stringify(fixture)}; mount(Fixture, { target: document.body });`;
          },
        },
        svelte({ configFile: false, emitCss: false }),
      ],
      build: {
        write: false,
        minify: false,
        rolldownOptions: {
          input: "virtual:ui-browser-fixture",
          output: { format: "iife" },
        },
      },
    });
    assert(!Array.isArray(bundle) && "output" in bundle);
    const script = bundle.output.find((item) => item.type === "chunk");
    assert(script);
    const styles = bundle.output
      .filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
      .map((item) =>
        typeof item.source === "string" ? item.source : new TextDecoder().decode(item.source),
      );
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setContent('<!doctype html><html lang="en"><body></body></html>');
      for (const content of styles) await page.addStyleTag({ content });
      await page.addScriptTag({ content: script.code });

      const checkbox = page.getByRole("checkbox", { name: "Automatic updates" });
      await expect(checkbox).toHaveAttribute("id", "updates");
      await expect(checkbox).toHaveAttribute("type", "button");
      await expect(checkbox).not.toBeChecked();
      await checkbox.focus();
      await page.keyboard.press("Space");
      await expect(checkbox).toBeChecked();
      await expect(page.getByTestId("checked")).toHaveText("true");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("submissions")).toHaveText("0");
      await page.getByRole("button", { name: "Reset checkbox" }).click();
      await expect(checkbox).not.toBeChecked();
      await page.locator('label[for="updates"]').click();
      await expect(checkbox).toBeChecked();

      const toggle = page.getByRole("switch", { name: "Start at login" });
      await expect(toggle).toHaveAttribute("id", "startup");
      await expect(toggle).toHaveAttribute("type", "button");
      await toggle.focus();
      await page.keyboard.press("Space");
      await expect(page.getByTestId("requested")).toHaveText("true");
      await expect(page.getByTestId("requests")).toHaveText("1");
      await expect(toggle).toBeDisabled();
      await expect(toggle).not.toBeChecked();
      await expect(page.getByTestId("enabled")).toHaveText("false");
      await toggle.evaluate((element) => element.click());
      await expect(page.getByTestId("requests")).toHaveText("1");
      await page.getByRole("button", { name: "Confirm switch" }).click();
      await expect(toggle).toBeEnabled();
      await expect(toggle).toBeChecked();
      await toggle.click();
      await expect(page.getByTestId("requested")).toHaveText("false");
      await expect(toggle).toBeChecked();
      await expect(toggle).toBeDisabled();
      await page.getByRole("button", { name: "Reject switch" }).click();
      await expect(toggle).toBeEnabled();
      await expect(toggle).toBeChecked();
      await toggle.click();
      await page.getByRole("button", { name: "Confirm switch" }).click();
      await expect(toggle).not.toBeChecked();
      await expect(page.getByTestId("requests")).toHaveText("3");

      await page.getByRole("button", { name: "Toggle disabled" }).click();
      await expect(checkbox).toBeDisabled();
      await expect(toggle).toBeDisabled();
      await page.locator('label[for="updates"]').click({ force: true });
      await checkbox.evaluate((element) => element.click());
      await expect(checkbox).toBeChecked();
      await expect(page.getByTestId("submissions")).toHaveText("0");
      await page.getByRole("button", { name: "Save fixture" }).click();
      await expect(page.getByTestId("submissions")).toHaveText("1");
      await page.getByRole("button", { name: "Toggle disabled" }).click();

      const filter = page.getByRole("button", { name: "Filter events", exact: true });
      await expect(filter).toHaveText("All events");
      await filter.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("selection")).toHaveText("attention");
      await expect(filter).toHaveText("Needs attention");
      await page.getByRole("button", { name: "Reset selection" }).click();
      await expect(filter).toHaveText("All events");

      const disclosure = page.getByRole("button", { name: "Report", exact: true });
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByText("Report contents", { exact: true })).not.toBeVisible();
      await disclosure.focus();
      await page.keyboard.press("Space");
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId("expanded")).toHaveText("true");
      await expect(page.getByText("Report contents", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Toggle from parent" }).click();
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByText("Report contents", { exact: true })).not.toBeVisible();

      const opener = page.getByRole("button", { name: "Open dialog" });
      await opener.click();
      const dialog = page.getByRole("dialog", { name: "Preferences" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAccessibleDescription("Choose which events to display.");
      await expect(dialog).toHaveCSS("position", "fixed");
      await expect(dialog).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      for (let index = 0; index < 6; index++) {
        await page.keyboard.press("Tab");
        assert(await dialog.evaluate((element) => element.contains(document.activeElement)));
      }
      await page.getByRole("button", { name: "Dialog filter", exact: true }).click();
      const option = page.getByRole("option", { name: "Needs attention" });
      await expect(option).toBeVisible();
      const menu = page.getByRole("listbox");
      await expect(menu).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      assert(
        Number(await menu.evaluate((element) => getComputedStyle(element).zIndex)) >
          Number(await dialog.evaluate((element) => getComputedStyle(element).zIndex)),
      );
      await option.click();
      await expect(page.getByTestId("selection")).toHaveText("attention");
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();

      await opener.click();
      await dialog.getByRole("button", { name: "关闭Preferences" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
      await opener.click();
      await page.locator(".cc-modal-overlay").click({ position: { x: 5, y: 5 } });
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();

      await page.addStyleTag({
        content:
          ":root { --cc-surface: rgb(19, 21, 36); --cc-control-surface: rgb(29, 31, 47); --cc-text: rgb(239, 241, 250); --cc-border: rgb(93, 99, 124); --cc-focus: rgb(184, 161, 240); --cc-fill: rgb(184, 161, 240); --cc-checked-text: rgb(19, 21, 36); }",
      });
      await expect(checkbox).toHaveCSS("background-color", "rgb(184, 161, 240)");
      await expect(checkbox).toHaveCSS("color", "rgb(19, 21, 36)");
      await expect(checkbox).toHaveCSS("width", "19px");
      await expect(toggle).toHaveCSS("width", "42px");
      await page.setViewportSize({ width: 320, height: 640 });
      await opener.click();
      await expect(dialog).toHaveCSS("background-color", "rgb(19, 21, 36)");
      await expect(dialog).toHaveCSS("color", "rgb(239, 241, 250)");
      const bounds = await dialog.boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320);
      await page.getByRole("button", { name: "Dialog filter", exact: true }).click();
      await expect(menu).toHaveCSS("background-color", "rgb(19, 21, 36)");
      const menuBounds = await menu.boundingBox();
      assert(menuBounds && menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 320);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
