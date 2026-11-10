import { readFileSync } from 'node:fs';
import { cleanDelegates } from './authority.mjs';
import { cleanFreshness } from './freshness.mjs';

export function parseConfig(text, { warn = (message) => console.warn(message) } = {}) {
  const config = JSON.parse(text);
  for (const key of ['admins', 'tiers', 'merge', 'verify']) {
    if (!config[key]) throw new Error(`pipeline.config.json is missing "${key}"`);
  }
  if (!Array.isArray(config.admins) || config.admins.length === 0) {
    throw new Error('pipeline.config.json needs at least one admin');
  }
  // Optional. Validated only when present, and never thrown on.
  if ('delegates' in config) config.delegates = cleanDelegates(config, warn);
  if ('models' in config) config.models = cleanModels(config.models, warn);
  // A malformed one fails closed, to "every branch up to date": see lib/freshness.mjs.
  if ('freshness' in config) config.freshness = cleanFreshness(config.freshness, warn);
  return config;
}

// Optional: { worker, workerComplex, workerSimple }, each a model name. Anything
// else is dropped with a warning.
const MODEL_ROLES = ['worker', 'workerComplex', 'workerSimple'];
export const MODEL_NAME = /^[A-Za-z0-9._:\[\]-]{1,100}$/;

function cleanModels(models, warn) {
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    warn('pipeline.config.json: "models" is not an object, so it was ignored.');
    return undefined;
  }
  const kept = {};
  for (const [role, name] of Object.entries(models)) {
    if (MODEL_ROLES.includes(role) && typeof name === 'string' && MODEL_NAME.test(name)) kept[role] = name;
    else warn(`pipeline.config.json: models.${role} was dropped.`);
  }
  return kept;
}

export function loadConfig(path = 'pipeline.config.json', options) {
  return parseConfig(readFileSync(path, 'utf8'), options);
}
