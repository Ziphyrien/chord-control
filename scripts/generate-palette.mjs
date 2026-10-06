// APCA Lc targets are design checks, not WCAG conformance ratings.
import { BackgroundColor, Color, Theme, convertColorValue } from "@adobe/leonardo-contrast-colors";
import { calcAPCA } from "apca-w3";
import { converter, formatHex } from "culori";
import { readFile, writeFile } from "node:fs/promises";

// Achromatic surfaces with a restrained copper brand, not a colored dark UI.
const seeds = {
  neutral: "#808080",
  primary: "#bc6c34",
  success: "#497d61",
  danger: "#ba4b42",
  warning: "#9a751e",
  info: "#527690",
};
const scales = Object.fromEntries(
  Object.entries(seeds).map(([name, seed]) => [
    name,
    new BackgroundColor({
      name,
      colorKeys: [seed],
      colorSpace: "OKLCH",
      ratios: [20],
      output: "HEX",
    }).backgroundColorScale,
  ]),
);
const shade = (name, lightness) => scales[name][Math.max(1, Math.min(99, Math.round(lightness)))];
const contrast = (foreground, background) => Math.abs(Number(calcAPCA(foreground, background)));

// Leonardo generates APCA-targeted foregrounds. Independently verify against the
// actual painted hex, rather than trusting its rounded HSLuv background alone.
function readable(name, background, target) {
  const base = new BackgroundColor({
    name: "base",
    colorKeys: [background],
    colorSpace: "OKLCH",
    ratios: [20],
  });
  const lightness = convertColorValue(background, "HSLuv", true).v;
  for (const margin of [2, 4, 6]) {
    const foreground = new Color({
      name,
      colorKeys: [seeds[name]],
      colorSpace: "OKLCH",
      ratios: { result: target + margin },
    });
    const theme = new Theme({
      colors: [base, foreground],
      backgroundColor: base,
      lightness,
      formula: "wcag3",
      output: "HEX",
    });
    const color = theme.contrastColorPairs.result;
    if (contrast(color, background) >= target) return color;
  }
  throw new Error(`Unreachable APCA Lc ${target}: ${name} on ${background}`);
}

const checks = [];
function palette(dark) {
  const neutral = (light, dim) => shade("neutral", dark ? dim : light);
  const surface = neutral(99, 14);
  const hover = neutral(94, 22);
  const accent = neutral(94, 22);
  const successSurface = shade("success", dark ? 21 : 95);
  const dangerSurface = shade("danger", dark ? 21 : 95);
  const warningSurface = shade("warning", dark ? 21 : 95);
  const infoSurface = shade("info", dark ? 21 : 95);
  // A filled control is neutral. Its label needs APCA, not the fill vs page.
  const fill = readable("neutral", hover, 80);
  const fillLightness = convertColorValue(fill, "HSLuv", true).v;
  const onFill = readable("neutral", fill, 78);
  const shadow = `${shade("neutral", dark ? 2 : 7)}${dark ? "a6" : "40"}`;
  const colors = {
    background: neutral(97, 9),
    surface,
    sidebar: neutral(95, 11),
    "control-surface": neutral(98, 17),
    "input-surface": neutral(99, 12),
    "control-hover": hover,
    text: readable("neutral", accent, 90),
    muted: readable("neutral", accent, 75),
    border: neutral(82, 38),
    "border-strong": neutral(61, 55),
    accent,
    "accent-text": readable("primary", accent, 80),
    focus: readable("primary", hover, 80),
    fill,
    "fill-hover": shade("neutral", fillLightness + (dark ? 3 : -3)),
    "on-fill": onFill,
    success: readable("success", successSurface, 80),
    danger: readable("danger", dangerSurface, 80),
    warning: readable("warning", warningSurface, 80),
    info: readable("info", infoSurface, 80),
    "success-surface": successSurface,
    "danger-surface": dangerSurface,
    "warning-surface": warningSurface,
    "info-surface": infoSurface,
    "checked-text": onFill,
    "switch-track": neutral(73, 38),
    "switch-thumb": neutral(98, 97),
    overlay: `${shade("neutral", 3)}c2`,
    "modal-shadow": `0 24px 90px ${shadow}`,
    "popover-shadow": `0 8px 24px ${shadow}`,
  };
  for (const [foreground, background, target] of [
    ["text", "background", 90],
    ["text", "surface", 90],
    ["text", "control-hover", 90],
    ["text", "accent", 90],
    ["text", "sidebar", 90],
    ["text", "control-surface", 90],
    ["text", "input-surface", 90],
    ["muted", "background", 75],
    ["muted", "surface", 75],
    ["muted", "control-hover", 75],
    ["muted", "accent", 75],
    ["muted", "sidebar", 75],
    ["muted", "control-surface", 75],
    ["muted", "input-surface", 75],
    ["accent-text", "accent", 75],
    ["success", "success-surface", 75],
    ["danger", "danger-surface", 75],
    ["warning", "warning-surface", 75],
    ["info", "info-surface", 75],
    ["on-fill", "fill", 75],
    ["on-fill", "fill-hover", 75],
  ]) {
    const score = contrast(colors[foreground], colors[background]);
    if (score < target)
      throw new Error(
        `${dark ? "dark" : "light"} ${foreground}/${background}: Lc ${score} < ${target}`,
      );
    checks.push({
      theme: dark ? "dark" : "light",
      foreground,
      background,
      Lc: Number(score.toFixed(1)),
      target,
    });
  }
  return colors;
}
const light = palette(false),
  dark = palette(true);
// Culori only serializes Leonardo's final sRGB paint into valid CSS OKLCH.
// It never selects a color or supplies an old palette input.
const oklch = converter("oklch");
function cssValue(value) {
  return value.replace(/#[0-9a-f]{6}(?:[0-9a-f]{2})?/gi, (hex) => {
    const { l, c, h, alpha = 1 } = oklch(hex);
    return `oklch(${Number((l * 100).toFixed(5))}% ${Number(c.toFixed(6))} ${Number((h ?? 0).toFixed(3))}${alpha < 1 ? ` / ${Number(alpha.toFixed(5))}` : ""})`;
  });
}
const css =
  [
    "/* Adobe Leonardo 1.1.0 / APCA (formula: wcag3). Generated by scripts/generate-palette.mjs. */",
    ...[
      [false, light],
      [true, dark],
    ].map(
      ([isDark, colors]) =>
        `${isDark ? ':root[data-cc-theme="dark"]' : ":root"} {\n  color-scheme: ${isDark ? "dark" : "light"};\n${Object.entries(
          colors,
        )
          .map(([name, value]) => `  --cc-${name}: ${cssValue(value)};`)
          .join("\n")}\n}`,
    ),
  ].join("\n") + "\n";
// Verify the actual serialized OKLCH paint after its round trip to sRGB.
for (const check of checks) {
  const colors = check.theme === "dark" ? dark : light;
  const foreground = formatHex(cssValue(colors[check.foreground]));
  const background = formatHex(cssValue(colors[check.background]));
  const score = contrast(foreground, background);
  if (score < check.target)
    throw new Error(
      `CSS OKLCH APCA check failed: ${check.theme} ${check.foreground}/${check.background}`,
    );
  check.Lc = Number(score.toFixed(1));
}
const output = new URL("../packages/ui/palette.css", import.meta.url);
if (process.argv.includes("--check")) {
  if ((await readFile(output, "utf8")) !== css)
    throw new Error("Palette is stale; run vp run theme:generate");
} else {
  await writeFile(output, css);
}
const iconPath = new URL("../resources/icon.svg", import.meta.url);
const icon = await readFile(iconPath, "utf8");
const iconColors = { background: dark.background, foreground: shade("primary", 66) };
const roles = new Set();
const expectedIcon = icon.replace(
  /data-cc-paint="(background|foreground)" (fill|stroke)="#[0-9a-f]+"/gi,
  (_, role, attribute) => {
    roles.add(role);
    return `data-cc-paint="${role}" ${attribute}="${iconColors[role]}"`;
  },
);
if (roles.size !== 2) throw new Error("Icon paint roles are missing");
if (contrast(iconColors.foreground, iconColors.background) < 45)
  throw new Error("Large icon glyph requires APCA Lc 45");
const configPath = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const configText = await readFile(configPath, "utf8");
const config = JSON.parse(configText);
const main = config.app.windows.find((window) => window.label === "main");
if (!main) throw new Error("Main window is not registered");
if (process.argv.includes("--check")) {
  if (icon !== expectedIcon || main.backgroundColor !== dark.background)
    throw new Error("Native/icon colors are stale; run vp run theme:generate");
} else {
  await writeFile(iconPath, expectedIcon);
  await writeFile(
    configPath,
    configText.replace(
      `"backgroundColor": "${main.backgroundColor}"`,
      `"backgroundColor": "${dark.background}"`,
    ),
  );
}
console.log(
  `${checks.length} APCA pairs verified; minimum Lc ${Math.min(...checks.map((check) => check.Lc))}`,
);
console.table(checks);
