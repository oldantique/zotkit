import type { ModelOption } from "./sidebar";

export function modelBackend(modelId: string): "engine" | "codex" {
  return modelId.startsWith("engine:") ? "engine" : "codex";
}

/**
 * Picks a fallback model to select when nothing is chosen yet or the current
 * selection turns out to be stale. `refreshModels` (codex-service.ts) mixes a
 * placeholder `{ id: "codex", label: "Codex（订阅）" }` into an engine-backend
 * model list purely so the dropdown can offer switching backends -- it is
 * never a real, sendable model. Excluding it here keeps every fallback site
 * (initial default, stale-selection reconciliation, backend-switch
 * resolution, onChooseCodexBackend) from ever sending the literal string
 * "codex" as a model id. Prefers the `isDefault` entry, then the first
 * remaining model, then "" when only the placeholder was present.
 */
export function defaultSelectableModel(models: ModelOption[]): string {
  const selectable = models.filter((model) => model.id !== "codex");
  const fallback = selectable.find((model) => model.isDefault) || selectable[0];
  return fallback?.id ?? "";
}

export function renderModelOptions(
  select: HTMLSelectElement,
  models: ModelOption[],
  selected: string,
): void {
  const doc = select.ownerDocument;
  select.replaceChildren();
  const groups: Array<{ label: string; members: ModelOption[] }> = [
    { label: "内置引擎", members: models.filter((model) => modelBackend(model.id) === "engine") },
    { label: "Codex（订阅）", members: models.filter((model) => modelBackend(model.id) === "codex") },
  ];
  for (const group of groups) {
    if (!group.members.length) continue;
    const optgroup = doc.createElement("optgroup");
    optgroup.label = group.label;
    for (const model of group.members) {
      const option = doc.createElement("option");
      option.value = model.id;
      option.textContent = model.label;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }
  if (selected) select.value = selected;
}
