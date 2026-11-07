import { readFileSync } from 'node:fs';

export function parseConfig(text) {
  const config = JSON.parse(text);
  for (const key of ['admins', 'tiers', 'merge', 'verify']) {
    if (!config[key]) throw new Error(`pipeline.config.json is missing "${key}"`);
  }
  if (!Array.isArray(config.admins) || config.admins.length === 0) {
    throw new Error('pipeline.config.json needs at least one admin');
  }
  return config;
}

export function loadConfig(path = 'pipeline.config.json') {
  return parseConfig(readFileSync(path, 'utf8'));
}
