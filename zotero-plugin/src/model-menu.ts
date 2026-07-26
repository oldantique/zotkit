import type { ModelOption } from "./sidebar";

export function modelBackend(modelId: string): "engine" | "codex" {
  return modelId.startsWith("engine:") ? "engine" : "codex";
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
