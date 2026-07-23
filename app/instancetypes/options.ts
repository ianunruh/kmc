import type { InstanceTypeInfo } from "~/lib/types";

/** Display order for common-instancetypes classes (then custom / unknown). */
const CLASS_ORDER = [
  "general.purpose",
  "overcommitted",
  "memory.intensive",
  "compute.exclusive",
  "dedicated.vcpu",
  "network",
  "realtime",
] as const;

const CLASS_LABELS: Record<string, string> = {
  "general.purpose": "General purpose",
  overcommitted: "Overcommitted",
  "memory.intensive": "Memory intensive",
  "compute.exclusive": "Compute exclusive",
  "dedicated.vcpu": "Dedicated vCPU",
  network: "Network",
  realtime: "Realtime",
};

/** Rough size rank so medium < large < xlarge inside a class. */
const SIZE_RANK: Record<string, number> = {
  nano: 10,
  micro: 20,
  small: 30,
  medium: 40,
  "2xmedium": 45,
  large: 50,
  large1gi: 51,
  xlarge: 60,
  xlarge1gi: 61,
  "2xlarge": 70,
  "2xlarge1gi": 71,
  "4xlarge": 80,
  "4xlarge1gi": 81,
  "8xlarge": 90,
  "8xlarge1gi": 91,
};

export function instanceTypeClassLabel(className?: string): string {
  if (!className) return "Other";
  return CLASS_LABELS[className] ?? className;
}

function classRank(className?: string): number {
  if (!className) return 1000;
  const idx = (CLASS_ORDER as readonly string[]).indexOf(className);
  return idx >= 0 ? idx : 500;
}

function sizeRank(size?: string, name?: string): number {
  if (size && SIZE_RANK[size] != null) return SIZE_RANK[size]!;
  // Fall back to parsing suffix after the last dot (u1.medium → medium).
  const suffix = name?.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  if (suffix && SIZE_RANK[suffix] != null) return SIZE_RANK[suffix]!;
  return 500;
}

export function sortInstanceTypes(items: InstanceTypeInfo[]): InstanceTypeInfo[] {
  return [...items].sort((a, b) => {
    const ca = classRank(a.class) - classRank(b.class);
    if (ca !== 0) return ca;
    const sa = sizeRank(a.size, a.name) - sizeRank(b.size, b.name);
    if (sa !== 0) return sa;
    const cpuA = Number(a.cpu) || 0;
    const cpuB = Number(b.cpu) || 0;
    if (cpuA !== cpuB) return cpuA - cpuB;
    return a.name.localeCompare(b.name);
  });
}

export function instanceTypeOptionLabel(it: InstanceTypeInfo): string {
  const size =
    it.cpu || it.memory
      ? `${it.cpu ?? "?"}c / ${it.memory ?? "?"}`
      : null;
  return size ? `${it.name} · ${size}` : it.name;
}

/**
 * Mantine Select data: grouped by common-instancetypes class when labels exist.
 * Falls back to a flat list for unlabeled / custom types only.
 */
export function instanceTypeSelectData(
  items: InstanceTypeInfo[],
): Array<{ group: string; items: Array<{ value: string; label: string }> }> {
  const sorted = sortInstanceTypes(items);
  const byClass = new Map<string, InstanceTypeInfo[]>();
  for (const it of sorted) {
    const key = it.class?.trim() || "__other__";
    const list = byClass.get(key) ?? [];
    list.push(it);
    byClass.set(key, list);
  }

  const groups: Array<{
    group: string;
    items: Array<{ value: string; label: string }>;
  }> = [];

  for (const className of CLASS_ORDER) {
    const list = byClass.get(className);
    if (!list?.length) continue;
    groups.push({
      group: instanceTypeClassLabel(className),
      items: list.map((it) => ({
        value: it.name,
        label: instanceTypeOptionLabel(it),
      })),
    });
    byClass.delete(className);
  }

  // Remaining classes (unknown vendor schemes) then unlabeled custom types.
  const restKeys = [...byClass.keys()].sort((a, b) => {
    if (a === "__other__") return 1;
    if (b === "__other__") return -1;
    return a.localeCompare(b);
  });
  for (const key of restKeys) {
    const list = byClass.get(key)!;
    groups.push({
      group: key === "__other__" ? "Custom" : instanceTypeClassLabel(key),
      items: list.map((it) => ({
        value: it.name,
        label: instanceTypeOptionLabel(it),
      })),
    });
  }

  return groups;
}

/** Prefer a sensible default from common-instancetypes (u1.medium, etc.). */
export function preferredInstanceTypeName(
  items: InstanceTypeInfo[],
): string | undefined {
  if (items.length === 0) return undefined;
  const preferred = [
    "u1.medium",
    "u1.large",
    "u1.small",
    "o1.medium",
    "u1.xlarge",
  ];
  for (const name of preferred) {
    if (items.some((it) => it.name === name)) return name;
  }
  const general = sortInstanceTypes(
    items.filter((it) => it.class === "general.purpose"),
  );
  if (general[0]) return general[0].name;
  return sortInstanceTypes(items)[0]?.name;
}
