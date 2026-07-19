// spec §7c-2: base テンプレ結果 + generation -> canonical relPath の唯一の導出規則。
// dedup 比較・enqueue・force・stale-miss・divergent 回復・adoption すべてがこれを使う。
export function canonicalRelPath(basePath: string, generation: number): string {
  if (generation <= 0) return basePath;
  const slash = basePath.lastIndexOf("/");
  const dir = slash >= 0 ? basePath.slice(0, slash + 1) : "";
  const name = slash >= 0 ? basePath.slice(slash + 1) : basePath;
  const dot = name.lastIndexOf(".");
  if (dot > 0) return `${dir}${name.slice(0, dot)}.rev${generation}${name.slice(dot)}`;
  return `${dir}${name}.rev${generation}`;
}
