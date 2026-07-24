import { build } from "esbuild";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("browser style bundle", () => {
  it("includes KaTeX CSS and emits its local fonts", async () => {
    const result = await build({
      entryPoints: [join(process.cwd(), "src/index.ts")],
      bundle: true,
      platform: "browser",
      format: "iife",
      target: ["firefox140"],
      write: false,
      outdir: "out",
      assetNames: "fonts/[name]-[hash]",
      loader: {
        ".svg": "dataurl",
        ".woff2": "file",
        ".woff": "file",
        ".ttf": "file",
      },
    });

    const css = result.outputFiles.find((file) => file.path.endsWith(".css"))?.text || "";
    const assets = result.outputFiles.map((file) => file.path.replaceAll("\\", "/"));
    expect(css).toContain(".katex");
    expect(css).toContain("@font-face");
    expect(css).toContain("KaTeX_Main-Regular");
    expect(assets.some((path) => /\/fonts\/KaTeX_[^/]+\.woff2$/.test(path))).toBe(true);
  });

  it("keeps float entries out of the sidebar's avatar grid", async () => {
    const result = await build({
      entryPoints: [join(process.cwd(), "src/index.ts")],
      bundle: true,
      platform: "browser",
      format: "iife",
      target: ["firefox140"],
      write: false,
      outdir: "out",
      assetNames: "fonts/[name]-[hash]",
      loader: {
        ".svg": "dataurl",
        ".woff2": "file",
        ".woff": "file",
        ".ttf": "file",
      },
    });

    const css = result.outputFiles.find((file) => file.path.endsWith(".css"))?.text || "";
    // The sidebar lays `.zc-entry-assistant` out as an avatar (22px) + content
    // grid. Float entries share the kind classes but render no avatar, so
    // without this override the answer text collapses into the 22px column.
    expect(css).toMatch(
      /\.zc-float-entry\.zc-entry-assistant,\s*\.zc-float-entry\.zc-entry-error\s*\{\s*display:\s*block;\s*\}/,
    );
  });

  it("declares the float transcript selectable and the float panel user-resizable", async () => {
    const result = await build({
      entryPoints: [join(process.cwd(), "src/index.ts")],
      bundle: true,
      platform: "browser",
      format: "iife",
      target: ["firefox140"],
      write: false,
      outdir: "out",
      assetNames: "fonts/[name]-[hash]",
      loader: {
        ".svg": "dataurl",
        ".woff2": "file",
        ".woff": "file",
        ".ttf": "file",
      },
    });

    const css = result.outputFiles.find((file) => file.path.endsWith(".css"))?.text || "";
    // XUL hosts don't allow text selection unless explicitly declared, so the
    // float transcript needs an explicit user-select: text rule (bug fix for
    // "can't select/copy the answer text").
    expect(css).toMatch(
      /\.zc-float-transcript,\s*\.zc-float-transcript \*\s*\{[^}]*user-select:\s*text;[^}]*\}/,
    );
    // The panel itself must be user-resizable via the native corner grip.
    expect(css).toMatch(/\.zc-float\s*\{[^}]*resize:\s*both;[^}]*\}/);
    // The blanket `cursor: auto` on every transcript descendant (needed so
    // selectable prose doesn't show a pointer) must not beat `cursor: pointer`
    // on the transcript's actually-clickable elements -- it only wins if this
    // rule comes later in the stylesheet.
    expect(css).toMatch(
      /\.zc-float-transcript \.zc-math-copy,\s*\.zc-float-transcript \.zc-copy-answer,\s*\.zc-float-transcript \.zc-turn-summary\s*\{[^}]*cursor:\s*pointer;[^}]*\}/,
    );
  });
});
