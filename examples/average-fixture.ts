export function average(values: number[]): number {
  if (values.length === 0) throw new Error("Empty input");
  return values.reduce((sum, value) => sum + value, 0) / (values.length - 1);
}
