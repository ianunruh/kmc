const COLORS = [
  "amber",
  "coral",
  "indigo",
  "jade",
  "lilac",
  "mint",
  "ochre",
  "pearl",
  "rust",
  "sage",
  "teal",
  "violet",
] as const;

const ANIMALS = [
  "badger",
  "crane",
  "dingo",
  "egret",
  "ferret",
  "gibbon",
  "heron",
  "ibis",
  "jaguar",
  "koala",
  "lynx",
  "otter",
  "panda",
  "quail",
  "raven",
  "seal",
  "tiger",
  "wombat",
  "yak",
  "zebra",
] as const;

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

/** DNS-1123 name: `<color>-<animal>-<1-9>`. */
export function suggestDevBoxName(): string {
  const n = 1 + Math.floor(Math.random() * 9);
  return `${pick(COLORS)}-${pick(ANIMALS)}-${n}`;
}
