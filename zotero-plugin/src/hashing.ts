/**
 * Shared SHA-256 helpers built on Gecko's `nsICryptoHash` XPCOM component --
 * the only hashing primitive available in Zotero's runtime (no WebCrypto).
 * Extracted from zotero-mutations.ts so other callers (e.g. paper-trail
 * anchors) can hash a file without depending on the mutations module.
 */

// keep in sync with platform.ts#makeLocalFile
function makeLocalFile(path: string): any {
  const file = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile);
  file.initWithPath(path);
  return file;
}

export function sha256Bytes(bytes: Uint8Array): string {
  const hash = Components.classes["@mozilla.org/security/hash;1"]
    .createInstance(Components.interfaces.nsICryptoHash);
  hash.init(hash.SHA256);
  hash.update(bytes, bytes.length);
  return binaryDigestToHex(hash.finish(false));
}

export function sha256File(path: string, size: number): string {
  const input = Components.classes["@mozilla.org/network/file-input-stream;1"]
    .createInstance(Components.interfaces.nsIFileInputStream);
  input.init(makeLocalFile(path), 0x01, 0, 0);
  try {
    const hash = Components.classes["@mozilla.org/security/hash;1"]
      .createInstance(Components.interfaces.nsICryptoHash);
    hash.init(hash.SHA256);
    hash.updateFromStream(input, size);
    return binaryDigestToHex(hash.finish(false));
  }
  finally {
    input.close();
  }
}

export function binaryDigestToHex(value: string): string {
  return [...value]
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
}
