import type { ReaderContext } from "./reader-context";
import type { CheckpointOption, DiffReview } from "./sidebar";
import { configuredLibraryRoot, makeLocalFile, profilePath, randomID } from "./platform";

export const ZOTERO_MUTATION_TOOL = "zotero_propose_changes" as const;

const EDITABLE_FIELDS = ["title", "abstractNote", "date", "DOI", "url", "extra"] as const;
const MAX_PDF_BYTES = 512 * 1024 * 1024;
const MAX_CHECKPOINTS = 20;
const MAX_PDF_CHECKPOINT_BYTES = 1024 * 1024 * 1024;
const MAX_REVIEWABLE_FIELD_CHARS = 20_000;

type EditableField = (typeof EDITABLE_FIELDS)[number];

export type ZoteroMutationOperation =
  | { type: "set_fields"; fields: Partial<Record<EditableField, string>> }
  | { type: "set_collections"; collectionKeys: string[] }
  | { type: "relink_attachment"; newPath: string }
  | { type: "replace_pdf"; stagedPath: string };

export interface PaperMutationSnapshot {
  schemaVersion: 1;
  paper: {
    id: number | string;
    key: string;
    libraryID: number | string;
    fields: Record<EditableField, string>;
    collectionKeys: string[];
  };
  attachment: {
    id: number | string;
    key: string;
    libraryID: number | string;
    rawPath: string;
    resolvedPath: string | null;
    linkMode: number | string | null;
  };
}

export interface PaperCheckpoint {
  schemaVersion: 1;
  id: string;
  label: string;
  createdAt: string;
  paperIdentity: string;
  snapshot: PaperMutationSnapshot;
  pdfBackupPath: string | null;
  pdfBackupBytes: number;
}

export interface StagedPdfFingerprint {
  canonicalPath: string;
  size: number;
  sha256: string;
}

interface StagedPdfBinding extends StagedPdfFingerprint {
  operationIndex: number;
  stagedPath: string;
}

export interface MutationEffects {
  attachmentID: number | string;
  attachmentKey: string;
  attachmentLibraryID: number | string;
  attachmentContentChanged: boolean;
  attachmentRelinked: boolean;
  pdfReplaced: boolean;
}

export interface MutationResolution {
  decision: "accepted" | "rejected";
  effects: MutationEffects;
  checkpointID?: string;
}

export class ZoteroMutationApplyError extends Error {
  constructor(
    message: string,
    readonly effects: MutationEffects,
    readonly checkpointID: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ZoteroMutationApplyError";
  }
}

export interface MutationHost {
  snapshot(context: ReaderContext): Promise<PaperMutationSnapshot>;
  describeCollections(libraryID: number | string, keys: readonly string[]): Promise<Map<string, string>>;
  validateOperations(
    context: ReaderContext,
    snapshot: PaperMutationSnapshot,
    operations: readonly ZoteroMutationOperation[],
  ): Promise<void>;
  fingerprintPdf(context: ReaderContext, path: string): Promise<StagedPdfFingerprint>;
  createCheckpoint(
    id: string,
    label: string,
    context: ReaderContext,
    snapshot: PaperMutationSnapshot,
    includePdf: boolean,
  ): Promise<PaperCheckpoint>;
  apply(
    context: ReaderContext,
    snapshot: PaperMutationSnapshot,
    operations: readonly ZoteroMutationOperation[],
    stagedPdfBindings: readonly StagedPdfBinding[],
  ): Promise<void>;
  restore(checkpoint: PaperCheckpoint): Promise<MutationEffects>;
  readCheckpoints(): Promise<PaperCheckpoint[]>;
  pruneCheckpoints(): Promise<void>;
}

export interface MutationServiceCallbacks {
  onState(): void;
  getContext(): ReaderContext | null;
}

export interface MutationToolSpec {
  type: "function";
  name: typeof ZOTERO_MUTATION_TOOL;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface PendingMutation {
  id: string;
  createdAt: string;
  paperIdentity: string;
  operations: ZoteroMutationOperation[];
  stagedPdfBindings: StagedPdfBinding[];
  snapshot: PaperMutationSnapshot;
  review: DiffReview;
}

/**
 * Cursor-style Apply/Diff/Checkpoint coordinator.
 *
 * The model can only propose a validated change. Applying or rejecting it is a
 * separate UI action, so a prompt-injected PDF can never approve its own
 * mutation through a dynamic-tool call.
 */
export class ZoteroMutationService {
  readonly tools: readonly MutationToolSpec[] = [MUTATION_TOOL_SPEC];

  private readonly pending = new Map<string, PendingMutation>();
  private readonly checkpoints = new Map<string, PaperCheckpoint>();
  private loadedCheckpoints = false;
  private resolveQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: MutationHost,
    private readonly callbacks: MutationServiceCallbacks,
    private readonly now: () => Date = () => new Date(),
    private readonly idFactory: (prefix: string) => string = randomID,
  ) {}

  getReviews(): DiffReview[] {
    return [...this.pending.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((entry) => ({ ...entry.review }));
  }

  async getCheckpoints(): Promise<CheckpointOption[]> {
    await this.ensureCheckpointsLoaded();
    return [...this.checkpoints.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((checkpoint) => ({
        id: checkpoint.id,
        label: checkpoint.label,
        createdAt: checkpoint.createdAt,
      }));
  }

  async invokeTool(
    tool: string,
    rawArguments: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (tool !== ZOTERO_MUTATION_TOOL) throw new Error(`Unknown Zotkit Agent tool: ${tool}`);
    const context = this.requireContext();
    const operations = parseOperations(rawArguments.operations);
    const snapshot = await this.host.snapshot(context);
    assertSnapshotMatchesContext(snapshot, context);
    await this.host.validateOperations(context, snapshot, operations);
    const stagedPdfBindings = await bindStagedPdfs(this.host, context, operations);
    const id = this.idFactory("review");
    const createdAt = this.now().toISOString();
    const diff = await buildMutationDiff(this.host, snapshot, operations, stagedPdfBindings);
    const review: DiffReview = {
      id,
      title: typeof rawArguments.title === "string" && rawArguments.title.trim()
        ? sanitizeDiffText(rawArguments.title.trim().slice(0, 160))
        : "Review proposed Zotero changes",
      summary: summarizeOperations(operations),
      diff,
      state: "pending",
    };
    this.pending.set(id, {
      id,
      createdAt,
      paperIdentity: paperIdentity(context),
      operations,
      stagedPdfBindings,
      snapshot,
      review,
    });
    this.callbacks.onState();
    return {
      status: "awaiting_user_review",
      reviewId: id,
      message: "The change is validated and visible in Zotkit. It has not been applied. The user must click Apply.",
      diff,
    };
  }

  /**
   * Entry point is deliberately synchronous up to the first await: it must
   * observe and flip `review.state` before yielding control, otherwise two
   * back-to-back clicks (or a double-submit) would both read "pending" and
   * both proceed to snapshot -> checkpoint -> apply. For replace_pdf the
   * second run would back up the already-replaced bytes as the checkpoint's
   * original.pdf, permanently destroying the only usable rollback.
   *
   * Once past that guard, the actual work is threaded through
   * `resolveQueue` so concurrent accepts on *different* reviews still run
   * one at a time rather than interleaving their host calls.
   */
  async resolveReview(
    reviewId: string,
    decision: "accept" | "reject",
  ): Promise<MutationResolution> {
    const pending = this.pending.get(reviewId);
    if (!pending) throw new Error("This change review has expired");
    if (pending.review.state !== "pending") {
      throw new Error("This change review was already resolved or is being applied");
    }
    pending.review.state = "resolving";
    this.callbacks.onState();

    const run = () => this.runResolveReview(pending, decision);
    // Chain onto the shared queue so a rejected run doesn't wedge later
    // reviews: the queue link swallows the error (`.catch(() => {})`) purely
    // to keep the chain alive, while the promise returned to *this* caller
    // is `result` itself, which still carries the real rejection.
    const result = this.resolveQueue.catch(() => {}).then(run);
    this.resolveQueue = result;
    return result;
  }

  private async runResolveReview(
    pending: PendingMutation,
    decision: "accept" | "reject",
  ): Promise<MutationResolution> {
    try {
      const effects = effectsForOperations(pending.snapshot, pending.operations);
      if (decision === "reject") {
        pending.review.state = "rejected";
        this.callbacks.onState();
        return { decision: "rejected", effects: noMutationEffects(pending.snapshot) };
      }
      const context = this.requireContext();
      if (paperIdentity(context) !== pending.paperIdentity) {
        throw new Error("The active Zotero paper changed. Re-open the proposal before applying it.");
      }
      const current = await this.host.snapshot(context);
      if (snapshotFingerprint(current) !== snapshotFingerprint(pending.snapshot)) {
        throw new Error("The Zotero item or attachment changed after this diff was prepared. Generate a fresh proposal.");
      }
      await this.host.validateOperations(context, current, pending.operations);
      const checkpointID = this.idFactory("checkpoint");
      const checkpoint = await this.host.createCheckpoint(
        checkpointID,
        pending.review.title,
        context,
        current,
        pending.operations.some((operation) => operation.type === "replace_pdf"),
      );
      await this.retainCheckpoint(checkpoint);
      try {
        await assertStagedPdfBindings(
          this.host,
          context,
          pending.operations,
          pending.stagedPdfBindings,
        );
      }
      catch (error) {
        pending.review.state = "failed";
        pending.review.summary = `The staged PDF no longer matches this review. Safety checkpoint ${checkpoint.id} remains available; generate a fresh proposal.`;
        this.callbacks.onState();
        throw error;
      }
      try {
        await this.host.apply(
          context,
          current,
          pending.operations,
          pending.stagedPdfBindings,
        );
      }
      catch (error) {
        let rollbackError: unknown = null;
        try {
          await this.host.restore(checkpoint);
        }
        catch (restoreError) {
          rollbackError = restoreError;
        }
        pending.review.state = "failed";
        pending.review.summary = rollbackError
          ? `Apply failed and automatic rollback also failed. Safety checkpoint ${checkpoint.id} remains available.`
          : `Apply failed and was rolled back automatically. Safety checkpoint ${checkpoint.id} remains available.`;
        this.callbacks.onState();
        const applyMessage = boundedError(error);
        const message = rollbackError
          ? `Apply failed: ${applyMessage}. Automatic rollback also failed: ${boundedError(rollbackError)}. Checkpoint ${checkpoint.id} remains available for manual Restore.`
          : `Apply failed: ${applyMessage}. Automatic rollback completed; checkpoint ${checkpoint.id} remains available.`;
        throw new ZoteroMutationApplyError(message, effects, checkpoint.id, { cause: error });
      }
      pending.review.state = "accepted";
      await this.host.pruneCheckpoints();
      this.checkpoints.clear();
      this.loadedCheckpoints = false;
      await this.ensureCheckpointsLoaded();
      this.callbacks.onState();
      return { decision: "accepted", effects, checkpointID: checkpoint.id };
    }
    catch (error) {
      // Only revert to "pending" if nothing above already committed this
      // review to a terminal "failed" state. That preserves the pre-existing
      // behavior where a stale-context/stale-snapshot guard failure leaves
      // the review retriable, while a failure after the point of no return
      // (checkpointed and applying) keeps its explicit "failed" state.
      if (pending.review.state === "resolving") {
        pending.review.state = "pending";
        this.callbacks.onState();
      }
      throw error;
    }
  }

  async restoreCheckpoint(checkpointID: string): Promise<MutationResolution> {
    await this.ensureCheckpointsLoaded();
    const checkpoint = this.checkpoints.get(checkpointID);
    if (!checkpoint) throw new Error("Checkpoint not found");
    const context = this.requireContext();
    if (paperIdentity(context) !== checkpoint.paperIdentity) {
      throw new Error("Open the checkpoint's paper in Zotero before restoring it");
    }
    const current = await this.host.snapshot(context);
    assertSnapshotMatchesContext(current, context);
    const undoCheckpoint = await this.host.createCheckpoint(
      this.idFactory("checkpoint"),
      `Before restoring: ${checkpoint.label}`,
      context,
      current,
      Boolean(checkpoint.pdfBackupPath),
    );
    await this.retainCheckpoint(undoCheckpoint);
    const effects = await this.host.restore(checkpoint);
    await this.host.pruneCheckpoints();
    this.checkpoints.clear();
    this.loadedCheckpoints = false;
    await this.ensureCheckpointsLoaded();
    this.callbacks.onState();
    return { decision: "accepted", effects, checkpointID: undoCheckpoint.id };
  }

  clearPaperReviews(context: ReaderContext): void {
    const identity = paperIdentity(context);
    for (const [id, pending] of this.pending) {
      if (pending.paperIdentity !== identity && pending.review.state === "pending") this.pending.delete(id);
    }
    this.callbacks.onState();
  }

  private requireContext(): ReaderContext {
    const context = this.callbacks.getContext();
    if (!context?.workspace) throw new Error("Open a PDF in the Zotero Reader first");
    return context;
  }

  private async ensureCheckpointsLoaded(): Promise<void> {
    if (this.loadedCheckpoints) return;
    this.loadedCheckpoints = true;
    const values = await this.host.readCheckpoints();
    for (const value of values) this.checkpoints.set(value.id, value);
  }

  private async retainCheckpoint(checkpoint: PaperCheckpoint): Promise<void> {
    await this.ensureCheckpointsLoaded();
    this.checkpoints.set(checkpoint.id, checkpoint);
    this.callbacks.onState();
  }
}

export function createZoteroMutationHost(
  zotero: any,
  ioUtils: any,
  pathUtils: any,
): MutationHost {
  const checkpointRoot = profilePath("checkpoints");

  const getItem = async (id: number | string): Promise<any> => {
    const item = await zotero.Items?.getAsync?.(id) || zotero.Items?.get?.(id);
    if (!item) throw new Error(`Zotero item ${id} is unavailable`);
    try {
      await zotero.Items?.loadDataTypes?.([item], ["itemData", "collections"]);
    }
    catch { /* already loaded on older runtimes */ }
    return item;
  };

  const snapshot = async (context: ReaderContext): Promise<PaperMutationSnapshot> => {
    const paperMetadata = context.parent || context.attachment;
    const paper = await getItem(paperMetadata.id);
    const attachment = await getItem(context.attachment.id);
    const collectionIDs = safeArray(paper.getCollections?.(true));
    const collectionKeys = collectionIDs
      .map((id) => zotero.Collections?.get?.(id)?.key)
      .filter((key): key is string => typeof key === "string" && Boolean(key));
    const fields = Object.fromEntries(
      EDITABLE_FIELDS.map((field) => [field, String(paper.getField?.(field) ?? "")]),
    ) as Record<EditableField, string>;
    const resolvedPath = await attachment.getFilePathAsync?.();
    return {
      schemaVersion: 1,
      paper: {
        id: paper.id,
        key: String(paper.key),
        libraryID: paper.libraryID,
        fields,
        collectionKeys,
      },
      attachment: {
        id: attachment.id,
        key: String(attachment.key),
        libraryID: attachment.libraryID,
        rawPath: String(attachment.attachmentPath ?? ""),
        resolvedPath: typeof resolvedPath === "string" ? resolvedPath : null,
        linkMode: attachment.attachmentLinkMode ?? null,
      },
    };
  };

  const describeCollections = async (
    libraryID: number | string,
    keys: readonly string[],
  ): Promise<Map<string, string>> => {
    const result = new Map<string, string>();
    for (const key of keys) {
      const collection = await zotero.Collections?.getByLibraryAndKeyAsync?.(libraryID, key)
        || zotero.Collections?.getByLibraryAndKey?.(libraryID, key);
      if (collection) result.set(key, String(collection.name || key));
    }
    return result;
  };

  const validateOperations = async (
    context: ReaderContext,
    current: PaperMutationSnapshot,
    operations: readonly ZoteroMutationOperation[],
  ): Promise<void> => {
    assertSnapshotMatchesContext(current, context);
    assertNoConflictingAttachmentOperations(operations);
    for (const operation of operations) {
      if (operation.type === "set_collections") {
        for (const key of operation.collectionKeys) {
          const collection = await zotero.Collections?.getByLibraryAndKeyAsync?.(current.paper.libraryID, key)
            || zotero.Collections?.getByLibraryAndKey?.(current.paper.libraryID, key);
          if (!collection || collection.deleted) throw new Error(`Collection ${key} does not exist in this Zotero library`);
        }
      }
      else if (operation.type === "relink_attachment") {
        if (Number(current.attachment.linkMode) !== Number(zotero.Attachments?.LINK_MODE_LINKED_FILE)) {
          throw new Error("Only linked-file attachments can be relinked. Stored Zotero attachments keep their managed path.");
        }
        const inspected = await validatePdfPath(
          operation.newPath,
          [configuredLibraryRoot()],
          ioUtils,
          RELINK_CONTAINMENT_ERROR,
        );
        // Store the canonical (post-normalize, pre-symlink) path back onto the
        // operation so the reviewed diff and Apply both act on exactly what was
        // validated here -- not a raw path that could still contain a
        // since-retargeted symlink segment.
        operation.newPath = inspected.canonicalPath;
      }
      else if (operation.type === "replace_pdf") {
        const allowedRoots = [context.workspace?.root, profilePath("staging")].filter(Boolean) as string[];
        await validatePdfPath(operation.stagedPath, allowedRoots, ioUtils);
        if (!current.attachment.resolvedPath) throw new Error("The active PDF path is unavailable");
        if (samePath(operation.stagedPath, current.attachment.resolvedPath)) {
          throw new Error("The staged PDF must be a separate file");
        }
      }
    }
  };

  const fingerprintPdf = async (
    context: ReaderContext,
    path: string,
  ): Promise<StagedPdfFingerprint> => {
    const allowedRoots = [context.workspace?.root, profilePath("staging")].filter(Boolean) as string[];
    const inspected = await validatePdfPath(path, allowedRoots, ioUtils);
    return {
      canonicalPath: inspected.canonicalPath,
      size: inspected.size,
      sha256: sha256File(inspected.canonicalPath, inspected.size),
    };
  };

  const invalidateZoteroFullText = async (attachment: any): Promise<void> => {
    const fulltext = zotero.Fulltext ?? zotero.FullText;
    if (
      typeof fulltext?.clearItemWords !== "function"
      || typeof zotero.DB?.executeTransaction !== "function"
    ) {
      throw new Error("Zotero full-text cache cannot be invalidated safely on this runtime");
    }
    await zotero.DB.executeTransaction(async () => {
      await fulltext.clearItemWords(attachment.id);
    });
    await zotero.Notifier?.trigger?.("modify", "item", [attachment.id], { [attachment.id]: {} });
    await fulltext?.queueItem?.(attachment);
  };

  const createCheckpoint = async (
    id: string,
    label: string,
    context: ReaderContext,
    value: PaperMutationSnapshot,
    includePdf: boolean,
  ): Promise<PaperCheckpoint> => {
    const directory = pathUtils.join(checkpointRoot, safeLeaf(id));
    await ioUtils.makeDirectory(directory, {
      createAncestors: true,
      ignoreExisting: true,
      permissions: 0o700,
    });
    let pdfBackupPath: string | null = null;
    let pdfBackupBytes = 0;
    if (includePdf) {
      if (!value.attachment.resolvedPath) throw new Error("Cannot checkpoint an unavailable PDF");
      const stat = await ioUtils.stat(value.attachment.resolvedPath);
      pdfBackupBytes = Number(stat?.size || 0);
      if (!Number.isFinite(pdfBackupBytes) || pdfBackupBytes <= 0 || pdfBackupBytes > MAX_PDF_BYTES) {
        throw new Error("The PDF is too large to checkpoint safely");
      }
      pdfBackupPath = pathUtils.join(directory, "original.pdf");
      await ioUtils.copy(value.attachment.resolvedPath, pdfBackupPath, { noOverwrite: true });
      await ioUtils.setPermissions?.(pdfBackupPath, 0o600, false);
    }
    const checkpoint: PaperCheckpoint = {
      schemaVersion: 1,
      id,
      label: label.slice(0, 160),
      createdAt: new Date().toISOString(),
      paperIdentity: paperIdentity(context),
      snapshot: value,
      pdfBackupPath,
      pdfBackupBytes,
    };
    const manifest = pathUtils.join(directory, "checkpoint.json");
    await ioUtils.writeUTF8(manifest, JSON.stringify(checkpoint, null, 2) + "\n", {
      tmpPath: manifest + ".tmp",
    });
    await ioUtils.setPermissions?.(manifest, 0o600, false);
    return checkpoint;
  };

  const apply = async (
    context: ReaderContext,
    current: PaperMutationSnapshot,
    operations: readonly ZoteroMutationOperation[],
    stagedPdfBindings: readonly StagedPdfBinding[],
  ): Promise<void> => {
    await validateOperations(context, current, operations);
    const paper = await getItem(current.paper.id);
    const attachment = await getItem(current.attachment.id);
    let attachmentContentChanged = false;
    try {
      for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
        const operation = operations[operationIndex]!;
        if (operation.type === "set_fields") {
          for (const [field, value] of Object.entries(operation.fields)) paper.setField(field, value);
          await paper.saveTx();
        }
        else if (operation.type === "set_collections") {
          paper.setCollections(operation.collectionKeys);
          await paper.saveTx({ skipDateModifiedUpdate: true });
        }
        else if (operation.type === "relink_attachment") {
          // Re-validate at Apply time (mirrors replace_pdf below): the review
          // ran validateOperations once already, but the window between that
          // check and this write is exactly where a symlink could be
          // retargeted. Re-resolving here and forwarding the fresh
          // canonicalPath -- never the caller-supplied operation.newPath --
          // closes that gap.
          const inspected = await validatePdfPath(
            operation.newPath,
            [configuredLibraryRoot()],
            ioUtils,
            RELINK_CONTAINMENT_ERROR,
          );
          await attachment.relinkAttachmentFile(inspected.canonicalPath);
          attachmentContentChanged = true;
        }
        else if (operation.type === "replace_pdf") {
          const target = current.attachment.resolvedPath;
          if (!target) throw new Error("The active PDF path is unavailable");
          const expected = stagedPdfBindings.find((entry) => entry.operationIndex === operationIndex);
          if (!expected) throw new Error("The staged PDF fingerprint is unavailable; generate a fresh proposal");
          const allowedRoots = [context.workspace?.root, profilePath("staging")].filter(Boolean) as string[];
          const inspected = await validatePdfPath(operation.stagedPath, allowedRoots, ioUtils);
          const bytes = await ioUtils.read(inspected.canonicalPath);
          const actual = {
            canonicalPath: inspected.canonicalPath,
            size: Number(bytes.length),
            sha256: sha256Bytes(bytes),
          };
          if (
            actual.canonicalPath !== expected.canonicalPath
            || actual.size !== expected.size
            || actual.sha256 !== expected.sha256
          ) {
            throw new Error("The staged PDF changed while Apply was starting. No replacement was written.");
          }
          await ioUtils.write(target, bytes, { tmpPath: target + `.zotkit-${safeLeaf(randomID("apply"))}.tmp` });
          attachmentContentChanged = true;
        }
      }
    }
    finally {
      if (attachmentContentChanged) await invalidateZoteroFullText(attachment);
    }
  };

  const restore = async (checkpoint: PaperCheckpoint): Promise<MutationEffects> => {
    const paper = await getItem(checkpoint.snapshot.paper.id);
    const attachment = await getItem(checkpoint.snapshot.attachment.id);
    if (String(paper.key) !== checkpoint.snapshot.paper.key || String(attachment.key) !== checkpoint.snapshot.attachment.key) {
      throw new Error("Checkpoint Zotero objects no longer match");
    }
    for (const field of EDITABLE_FIELDS) paper.setField(field, checkpoint.snapshot.paper.fields[field]);
    paper.setCollections(checkpoint.snapshot.paper.collectionKeys);
    await paper.saveTx({ skipDateModifiedUpdate: true });
    const attachmentRelinked = String(attachment.attachmentPath ?? "") !== checkpoint.snapshot.attachment.rawPath;
    if (attachmentRelinked) {
      attachment.attachmentPath = checkpoint.snapshot.attachment.rawPath;
      await attachment.saveTx({ skipDateModifiedUpdate: true });
    }
    const pdfReplaced = Boolean(checkpoint.pdfBackupPath && checkpoint.snapshot.attachment.resolvedPath);
    if (checkpoint.pdfBackupPath && checkpoint.snapshot.attachment.resolvedPath) {
      const bytes = await ioUtils.read(checkpoint.pdfBackupPath);
      const target = checkpoint.snapshot.attachment.resolvedPath;
      await ioUtils.write(target, bytes, { tmpPath: target + `.zotkit-${safeLeaf(randomID("restore"))}.tmp` });
    }
    if (attachmentRelinked || pdfReplaced) await invalidateZoteroFullText(attachment);
    return {
      attachmentID: checkpoint.snapshot.attachment.id,
      attachmentKey: checkpoint.snapshot.attachment.key,
      attachmentLibraryID: checkpoint.snapshot.attachment.libraryID,
      attachmentContentChanged: attachmentRelinked || pdfReplaced,
      attachmentRelinked,
      pdfReplaced,
    };
  };

  const readCheckpoints = async (): Promise<PaperCheckpoint[]> => {
    const paths = await ioUtils.getChildren(checkpointRoot).catch(() => []);
    const values: PaperCheckpoint[] = [];
    for (const directory of paths) {
      try {
        const stat = await ioUtils.stat(directory);
        if (stat?.type !== "directory") continue;
        const manifest = JSON.parse(await ioUtils.readUTF8(pathUtils.join(directory, "checkpoint.json")));
        if (isCheckpoint(manifest)) values.push(manifest);
      }
      catch { /* ignore incomplete checkpoint directories */ }
    }
    return values;
  };

  const pruneCheckpoints = async (): Promise<void> => {
    const values = (await readCheckpoints()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    let pdfBytes = 0;
    for (let index = 0; index < values.length; index += 1) {
      const checkpoint = values[index]!;
      pdfBytes += checkpoint.pdfBackupBytes;
      if (index < MAX_CHECKPOINTS && pdfBytes <= MAX_PDF_CHECKPOINT_BYTES) continue;
      const directory = pathUtils.join(checkpointRoot, safeLeaf(checkpoint.id));
      await ioUtils.remove(directory, { recursive: true, ignoreAbsent: true });
    }
  };

  return {
    snapshot,
    describeCollections,
    validateOperations,
    fingerprintPdf,
    createCheckpoint,
    apply,
    restore,
    readCheckpoints,
    pruneCheckpoints,
  };
}

export const MUTATION_TOOL_SPEC: MutationToolSpec = {
  type: "function",
  name: ZOTERO_MUTATION_TOOL,
  description:
    "Prepare a reviewable diff for the active Zotero paper. This never applies changes. The user must explicitly click Apply in Zotkit. Supports metadata fields, exact existing-collection membership, linked-attachment relinking, and replacing the current PDF from a staged PDF inside Zotkit's private workspace.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short user-facing title for the proposed change" },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          oneOf: [
            {
              type: "object",
              properties: {
                type: { const: "set_fields" },
                fields: {
                  type: "object",
                  properties: Object.fromEntries(EDITABLE_FIELDS.map((field) => [field, { type: "string" }])),
                  additionalProperties: false,
                },
              },
              required: ["type", "fields"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                type: { const: "set_collections" },
                collectionKeys: { type: "array", items: { type: "string" }, uniqueItems: true },
              },
              required: ["type", "collectionKeys"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                type: { const: "relink_attachment" },
                newPath: { type: "string" },
              },
              required: ["type", "newPath"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                type: { const: "replace_pdf" },
                stagedPath: { type: "string" },
              },
              required: ["type", "stagedPath"],
              additionalProperties: false,
            },
          ],
        },
      },
    },
    required: ["operations"],
    additionalProperties: false,
  },
};

export function parseOperations(raw: unknown): ZoteroMutationOperation[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) {
    throw new Error("operations must contain between 1 and 20 changes");
  }
  const operations: ZoteroMutationOperation[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid mutation operation");
    const operation = value as Record<string, unknown>;
    if (operation.type === "set_fields") {
      if (!operation.fields || typeof operation.fields !== "object" || Array.isArray(operation.fields)) {
        throw new Error("set_fields requires a fields object");
      }
      const fields: Partial<Record<EditableField, string>> = {};
      for (const [field, fieldValue] of Object.entries(operation.fields as Record<string, unknown>)) {
        if (!EDITABLE_FIELDS.includes(field as EditableField)) throw new Error(`Field ${field} is not editable`);
        if (typeof fieldValue !== "string") throw new Error(`Field ${field} must be text`);
        if (fieldValue.length > MAX_REVIEWABLE_FIELD_CHARS) {
          throw new Error(`Field ${field} exceeds the ${MAX_REVIEWABLE_FIELD_CHARS}-character reviewable limit`);
        }
        fields[field as EditableField] = fieldValue;
      }
      if (!Object.keys(fields).length) throw new Error("set_fields cannot be empty");
      operations.push({ type: "set_fields", fields });
    }
    else if (operation.type === "set_collections") {
      if (!Array.isArray(operation.collectionKeys)) throw new Error("set_collections requires collectionKeys");
      const keys = [...new Set(operation.collectionKeys.map((key) => {
        if (typeof key !== "string" || !/^[A-Z0-9]{8}$/i.test(key)) throw new Error("Invalid Zotero collection key");
        return key.toUpperCase();
      }))];
      operations.push({ type: "set_collections", collectionKeys: keys });
    }
    else if (operation.type === "relink_attachment") {
      if (typeof operation.newPath !== "string") throw new Error("relink_attachment requires newPath");
      operations.push({ type: "relink_attachment", newPath: operation.newPath });
    }
    else if (operation.type === "replace_pdf") {
      if (typeof operation.stagedPath !== "string") throw new Error("replace_pdf requires stagedPath");
      operations.push({ type: "replace_pdf", stagedPath: operation.stagedPath });
    }
    else {
      throw new Error(`Unsupported mutation operation: ${String(operation.type)}`);
    }
  }
  assertNoConflictingAttachmentOperations(operations);
  return operations;
}

function assertNoConflictingAttachmentOperations(
  operations: readonly ZoteroMutationOperation[],
): void {
  const relinks = operations.some((operation) => operation.type === "relink_attachment");
  const replacements = operations.some((operation) => operation.type === "replace_pdf");
  if (relinks && replacements) {
    throw new Error("relink_attachment and replace_pdf cannot be combined in one proposal");
  }
}

async function buildMutationDiff(
  host: MutationHost,
  snapshot: PaperMutationSnapshot,
  operations: readonly ZoteroMutationOperation[],
  stagedPdfBindings: readonly StagedPdfBinding[],
): Promise<string> {
  const lines = ["--- Zotero (current)", "+++ Zotero (proposed)"];
  for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
    const operation = operations[operationIndex]!;
    if (operation.type === "set_fields") {
      for (const [field, value] of Object.entries(operation.fields)) {
        lines.push(
          `@@ metadata.${field} @@`,
          ...diffValueLines("-", snapshot.paper.fields[field as EditableField]),
          ...diffValueLines("+", value),
        );
      }
    }
    else if (operation.type === "set_collections") {
      const allKeys = [...new Set([...snapshot.paper.collectionKeys, ...operation.collectionKeys])];
      const labels = await host.describeCollections(snapshot.paper.libraryID, allKeys);
      lines.push("@@ collections @@");
      for (const key of snapshot.paper.collectionKeys.filter((key) => !operation.collectionKeys.includes(key))) {
        lines.push(`- ${sanitizeDiffText(labels.get(key) || key)} (${key})`);
      }
      for (const key of operation.collectionKeys.filter((key) => !snapshot.paper.collectionKeys.includes(key))) {
        lines.push(`+ ${sanitizeDiffText(labels.get(key) || key)} (${key})`);
      }
      if (snapshot.paper.collectionKeys.join("\0") === operation.collectionKeys.join("\0")) lines.push("  (no membership change)");
    }
    else if (operation.type === "relink_attachment") {
      lines.push(
        "@@ attachment.link @@",
        ...diffValueLines("-", snapshot.attachment.resolvedPath || snapshot.attachment.rawPath),
        ...diffValueLines("+", operation.newPath),
      );
    }
    else {
      const binding = stagedPdfBindings.find((entry) => entry.operationIndex === operationIndex);
      lines.push(
        "@@ PDF contents @@",
        ...diffValueLines("-", snapshot.attachment.resolvedPath || "current PDF"),
        ...diffValueLines("+", operation.stagedPath, "staged replacement: "),
        binding ? `  SHA-256 ${binding.sha256} · ${binding.size} bytes` : "  (staged PDF fingerprint unavailable)",
        "  A byte-for-byte backup will be checkpointed before Apply.",
      );
    }
  }
  return lines.join("\n");
}

async function bindStagedPdfs(
  host: MutationHost,
  context: ReaderContext,
  operations: readonly ZoteroMutationOperation[],
): Promise<StagedPdfBinding[]> {
  const bindings: StagedPdfBinding[] = [];
  for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
    const operation = operations[operationIndex]!;
    if (operation.type !== "replace_pdf") continue;
    const fingerprint = await host.fingerprintPdf(context, operation.stagedPath);
    bindings.push({
      operationIndex,
      stagedPath: operation.stagedPath,
      ...fingerprint,
    });
  }
  return bindings;
}

async function assertStagedPdfBindings(
  host: MutationHost,
  context: ReaderContext,
  operations: readonly ZoteroMutationOperation[],
  expected: readonly StagedPdfBinding[],
): Promise<void> {
  const actual = await bindStagedPdfs(host, context, operations);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("The staged PDF changed after this diff was prepared. Generate a fresh proposal before Apply.");
  }
}

function effectsForOperations(
  snapshot: PaperMutationSnapshot,
  operations: readonly ZoteroMutationOperation[],
): MutationEffects {
  const attachmentRelinked = operations.some((operation) => operation.type === "relink_attachment");
  const pdfReplaced = operations.some((operation) => operation.type === "replace_pdf");
  return {
    attachmentID: snapshot.attachment.id,
    attachmentKey: snapshot.attachment.key,
    attachmentLibraryID: snapshot.attachment.libraryID,
    attachmentContentChanged: attachmentRelinked || pdfReplaced,
    attachmentRelinked,
    pdfReplaced,
  };
}

function noMutationEffects(snapshot: PaperMutationSnapshot): MutationEffects {
  return {
    attachmentID: snapshot.attachment.id,
    attachmentKey: snapshot.attachment.key,
    attachmentLibraryID: snapshot.attachment.libraryID,
    attachmentContentChanged: false,
    attachmentRelinked: false,
    pdfReplaced: false,
  };
}

function summarizeOperations(operations: readonly ZoteroMutationOperation[]): string {
  const labels = operations.map((operation) => ({
    set_fields: "metadata",
    set_collections: "collections",
    relink_attachment: "attachment link",
    replace_pdf: "PDF contents",
  })[operation.type]);
  return `Proposes ${operations.length} change${operations.length === 1 ? "" : "s"}: ${[...new Set(labels)].join(", ")}. Nothing changes until Apply.`;
}

function paperIdentity(context: ReaderContext): string {
  return `${context.attachment.libraryID ?? "0"}-${context.attachment.key}`;
}

function assertSnapshotMatchesContext(snapshot: PaperMutationSnapshot, context: ReaderContext): void {
  if (
    String(snapshot.attachment.id) !== String(context.attachment.id)
    || snapshot.attachment.key !== context.attachment.key
    || String(snapshot.attachment.libraryID) !== String(context.attachment.libraryID)
  ) {
    throw new Error("The active attachment changed while preparing the proposal");
  }
}

function snapshotFingerprint(snapshot: PaperMutationSnapshot): string {
  return JSON.stringify(snapshot);
}

// C0 controls (except the \t/\n we render verbatim), C1 controls, DEL (U+007F),
// and the Unicode bidi-override/embedding/isolate characters that can visually
// reorder or hide text in a terminal or HTML view. A prompt-injected
// proposal could otherwise use these to make the reviewed diff *display*
// something other than the bytes Apply actually writes.
const DANGEROUS_DIFF_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F\u0080-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Replaces control characters and bidi-override characters with a visible
 * `\uXXXX` literal escape so they can never render as invisible or
 * direction-flipping bytes inside the reviewed diff. `\n` and `\t` pass
 * through untouched -- they are rendered as real line breaks/tabs by the
 * line-splitting in {@link diffValueLines}.
 */
export function sanitizeDiffText(value: string): string {
  return value.replace(DANGEROUS_DIFF_CHARS, (char) => (
    `\\u${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`
  ));
}

/**
 * Renders `value` as diff lines carrying `sign` ("-" or "+"), showing every
 * character that will actually be read or written -- no truncation, no
 * newline-flattening. The first line carries an optional label prefix
 * (e.g. "staged replacement: "); every line after the first repeats the
 * same sign with matching indentation so `.zc-diff-view`'s prefix-based
 * `+`/`-` styling stays correct for the full value, not just its first line.
 */
function diffValueLines(sign: "-" | "+", value: unknown, labelPrefix = ""): string[] {
  const text = sanitizeDiffText(String(value ?? ""));
  if (!text) return [`${sign} ${labelPrefix}(empty)`];
  return text.split("\n").map((row, index) => (
    index === 0 ? `${sign} ${labelPrefix}${row}` : `${sign}   ${row}`
  ));
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const clean = sanitizeDiffText(message.replace(/[\r\n]+/g, " ").trim() || "unknown error");
  return clean.length > 500 ? `${clean.slice(0, 500)}…` : clean;
}

function sha256Bytes(bytes: Uint8Array): string {
  const hash = Components.classes["@mozilla.org/security/hash;1"]
    .createInstance(Components.interfaces.nsICryptoHash);
  hash.init(hash.SHA256);
  hash.update(bytes, bytes.length);
  return binaryDigestToHex(hash.finish(false));
}

function sha256File(path: string, size: number): string {
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

function binaryDigestToHex(value: string): string {
  return [...value]
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
}

const DEFAULT_PDF_CONTAINMENT_ERROR = "Replacement PDFs must be staged inside Zotkit's private paper workspace";
const RELINK_CONTAINMENT_ERROR = "Relink targets must live under the configured PDF library root";

async function validatePdfPath(
  path: string,
  allowedRoots: readonly string[] | null,
  ioUtils: any,
  containmentError: string = DEFAULT_PDF_CONTAINMENT_ERROR,
): Promise<{ canonicalPath: string; size: number }> {
  if (!path.startsWith("/")) throw new Error("PDF paths must be absolute");
  if (!path.toLowerCase().endsWith(".pdf")) throw new Error("The selected file must end in .pdf");
  const file = makeLocalFile(path);
  // Check isSymlink() on the raw, unresolved leaf *before* normalize() runs.
  // normalize() resolves the whole symlink chain to its target, so checking
  // isSymlink() afterward always inspects the *resolved* file -- which is
  // never itself a symlink -- making the check permanently dead. Checking
  // first, against the still-unresolved path, is the only way it can ever
  // see the link.
  if (file.isSymlink?.()) throw new Error("Symbolic-link PDF targets are not accepted");
  file.normalize?.();
  const canonicalPath = String(file.path || path);
  if (allowedRoots) {
    // Defense-in-depth: filter out invalid roots (falsy, empty, whitespace-only, or "/")
    // to prevent an empty root from accepting any absolute path via isWithin("")
    const validRoots = allowedRoots.filter((root) => {
      if (!root) return false;
      const trimmed = root.trim();
      if (!trimmed || trimmed === "/") return false;
      return true;
    });
    if (validRoots.length === 0 && allowedRoots.length > 0) {
      // Provided roots but none valid — fail closed
      throw new Error(containmentError);
    }
    if (validRoots.length > 0 && !validRoots.some((root) => {
      const rootFile = makeLocalFile(root);
      rootFile.normalize?.();
      return isWithin(canonicalPath, String(rootFile.path || root));
    })) {
      throw new Error(containmentError);
    }
  }
  const stat = await ioUtils.stat(canonicalPath);
  if (stat?.type !== "regular") throw new Error("The PDF path is not a regular file");
  const size = Number(stat.size || 0);
  if (!Number.isFinite(size) || size <= 4 || size > MAX_PDF_BYTES) throw new Error("The PDF size is invalid or exceeds 512 MiB");
  const header = await ioUtils.read(canonicalPath, { maxBytes: 5 });
  if (String.fromCharCode(...header) !== "%PDF-") throw new Error("The staged file does not have a PDF header");
  return { canonicalPath, size };
}

// Exported for testing empty-root edge cases
export { validatePdfPath };

function isWithin(path: string, root: string): boolean {
  const cleanRoot = root.replace(/\/+$/, "");
  return path === cleanRoot || path.startsWith(`${cleanRoot}/`);
}

function samePath(left: string, right: string): boolean {
  return left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
}

function safeLeaf(value: string): string {
  const leaf = value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 96);
  if (!leaf || leaf === "." || leaf === "..") throw new Error("Invalid checkpoint identifier");
  return leaf;
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isCheckpoint(value: unknown): value is PaperCheckpoint {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && typeof record.id === "string"
    && typeof record.label === "string"
    && typeof record.createdAt === "string"
    && typeof record.paperIdentity === "string"
    && Boolean(record.snapshot && typeof record.snapshot === "object")
    && (record.pdfBackupPath === null || typeof record.pdfBackupPath === "string")
    && typeof record.pdfBackupBytes === "number";
}
