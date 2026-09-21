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
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setContent('<!doctype html><html lang="en"><body></body></html>');
      await page.addScriptTag({ content: script.code });

      // Host banner classes must not turn shared messages into nested panels.
      await page.addStyleTag({
        content: `.notice, .success, .error, .actions, .content, .heading, .label, .check {
          padding: 16px 18px; margin-bottom: 24px; border: 1px solid;
          background: rgb(30, 55, 20); display: flex; gap: 16px;
        }`,
      });
      async function undecorated(locator) {
        const style = await locator.evaluate((element) => {
          const value = getComputedStyle(element);
          return {
            padding: value.padding,
            margin: value.margin,
            border: value.borderWidth,
            background: value.backgroundColor,
          };
        });
        assert.deepEqual(style, {
          padding: "0px",
          margin: "0px",
          border: "0px",
          background: "rgba(0, 0, 0, 0)",
        });
      }
      for (const tone of ["neutral", "success", "error"]) {
        const notice = page.locator(`#notice-${tone}`);
        await expect(notice).toHaveAttribute("role", tone === "error" ? "alert" : "status");
        await expect(notice).toHaveAttribute("aria-atomic", "true");
        await undecorated(notice);
      }
      await undecorated(
        page.getByRole("button", { name: "Page action", exact: true }).locator(".."),
      );
      await undecorated(page.getByTestId("page-content").locator(".."));
      await expect(page.locator("#page-facts dd")).toHaveText("Ready");

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
      await undecorated(filter.locator("span").first());
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
      await undecorated(dialog.getByRole("heading").locator(".."));
      await expect(dialog).toHaveCSS("position", "fixed");
      await expect(dialog).toHaveCSS("background-color", "rgb(255, 255, 255)");
      for (let index = 0; index < 6; index++) {
        await page.keyboard.press("Tab");
        assert(await dialog.evaluate((element) => element.contains(document.activeElement)));
      }
      await page.getByRole("button", { name: "Dialog filter", exact: true }).click();
      const option = page.getByRole("option", { name: "Needs attention" });
      await expect(option).toBeVisible();
      await undecorated(option.locator("span[aria-hidden=true]"));
      const menu = page.getByRole("listbox");
      await expect(menu).toHaveCSS("background-color", "rgb(255, 255, 255)");
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
          ":root { --cc-surface: #202122; --cc-control-surface: #25282b; --cc-text: #e8e8ea; --cc-border: #393c3f; --cc-focus: #b2d3a2; }",
      });
      await expect(checkbox).toHaveCSS("background-color", "rgb(178, 211, 162)");
      await expect(checkbox).toHaveCSS("color", "rgb(32, 33, 34)");
      await expect(checkbox).toHaveCSS("width", "19px");
      await expect(toggle).toHaveCSS("width", "42px");
      await page.setViewportSize({ width: 320, height: 640 });
      await opener.click();
      await expect(dialog).toHaveCSS("background-color", "rgb(32, 33, 34)");
      await expect(dialog).toHaveCSS("color", "rgb(232, 232, 234)");
      const bounds = await dialog.boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320);
      await page.getByRole("button", { name: "Dialog filter", exact: true }).click();
      await expect(menu).toHaveCSS("background-color", "rgb(32, 33, 34)");
      const menuBounds = await menu.boundingBox();
      assert(menuBounds && menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 320);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
