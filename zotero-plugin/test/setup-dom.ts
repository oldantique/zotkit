// happy-dom does not currently expose Document.compatMode. KaTeX checks it at
// module initialization, so model the standards-mode Zotero window used in
// production before test modules are imported.
if (typeof document !== "undefined" && document.compatMode !== "CSS1Compat") {
  Object.defineProperty(document, "compatMode", {
    configurable: true,
    value: "CSS1Compat",
  });
}
