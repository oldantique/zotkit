# Zotero's WebDAV attachment storage format

Zotero can sync attachment *files* to a user-provided WebDAV server instead of Zotero
File Storage. The Web API cannot serve or accept file bytes for such libraries, so a
headless tool must speak the WebDAV layout itself. The format is undocumented; what
follows was determined by interoperability inspection of a real library (uploading with
zotkit, then verifying that desktop clients sync and open the files normally) and is
what zotkit implements.

## Layout

Zotero stores everything flat inside the `zotero/` directory on the WebDAV server
(the desktop app appends `/zotero/` to the configured URL). For an attachment item
with key `K` (an 8-character Zotero item key):

| Object | Content |
|---|---|
| `K.zip` | A ZIP archive containing the attachment file, named **exactly** as the item's `filename` field. One file per archive for normal attachments. |
| `K.prop` | A small XML document with the file's modification time and MD5 (see below). |

`K.prop`:

```xml
<properties version="1"><mtime>1720512345678</mtime><hash>d41d8cd98f00b204e9800998ecf8427e</hash></properties>
```

- `mtime` — file modification time in **milliseconds** since the epoch.
- `hash` — MD5 of the **original file** (not of the zip).

## Upload flow (what zotkit does)

1. Compute `md5` and `mtime` (ms) of the local file.
2. Create the child attachment item via the Web API with
   `linkMode = "imported_file"`, `filename`, `contentType`, **and the `md5` and
   `mtime` fields set directly**. For WebDAV-backed libraries the API accepts these
   on item create/update (for Zotero-File-Storage libraries you must use the
   dedicated file-upload endpoints instead, and the API manages them itself).
3. `PUT <webdav>/zotero/K.zip` — zip containing the file, arcname = `filename`.
4. `PUT <webdav>/zotero/K.prop` — the XML above.

The item's `md5`/`mtime` must match `K.prop`, which must match the file inside
`K.zip` — that agreement is exactly what desktop clients check when deciding whether
their local copy is current. Once the three agree, every synced desktop downloads and
opens the file normally.

## Download flow

`GET K.zip`, extract the single member. (`K.prop` can be used to verify the MD5
after extraction.)

## Notes and caveats

- The desktop client also maintains a `lastsync.txt` marker in the directory; zotkit
  does not touch it and desktop syncs have been unaffected in practice.
- Zotero applies the same layout for group libraries only when using its own storage;
  WebDAV sync is **personal libraries only** (a Zotero limitation, not zotkit's).
- Linked-file attachments (`linkMode = "linked_file"`) store no bytes on WebDAV at
  all; only `imported_file`/`imported_url` attachments have `K.zip`/`K.prop` pairs.
- Reference implementation: `zotkit/core.py` → `Zot.attach` / `Zot.fetch`.
