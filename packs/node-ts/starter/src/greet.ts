export function greet(name: string | null): string {
  return `Hello, ${name?.trim() || 'world'}!`;
}
