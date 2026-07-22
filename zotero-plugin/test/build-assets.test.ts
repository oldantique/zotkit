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
});
