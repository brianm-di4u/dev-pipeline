// Reads the council's seat definitions so they can be passed inline. This is for
// hosts where a project's .claude/agents aren't registered, such as a session that
// started before those files existed. The prompts and models stay the same, but the
// tool limits in the seat's frontmatter don't apply, so the brief says not to edit.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function parseAgentFile(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error('Agent file has no frontmatter');
  const field = (name) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(match[1])?.[1]?.trim() ?? null;
  return { name: field('name'), model: field('model'), effort: field('effort'), body: match[2].trim() };
}

export function loadPersonas(dir = join('.claude', 'agents')) {
  if (!existsSync(dir)) return {};
  const personas = {};
  for (const file of readdirSync(dir).filter((name) => /^council-.*\.md$/.test(name))) {
    const agent = parseAgentFile(readFileSync(join(dir, file), 'utf8'));
    personas[agent.name] = agent;
  }
  return personas;
}
