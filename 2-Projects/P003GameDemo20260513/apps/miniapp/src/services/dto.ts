export function snakeToCamel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeToCamel);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), snakeToCamel(child)]));
}
