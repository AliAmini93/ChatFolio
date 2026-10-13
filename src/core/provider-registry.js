/**
 * Provider identity, independent of page DOM APIs.
 * These hostnames deliberately match the deployed v1.8.11 detector.
 * Later provider modules will use this registry as their only host dispatch.
 */
export const PROVIDERS = Object.freeze({
  chatgpt: Object.freeze({ id: 'chatgpt', label: 'ChatGPT', hosts: Object.freeze(['chatgpt.com', 'chat.openai.com']) }),
  claude: Object.freeze({ id: 'claude', label: 'Claude', hosts: Object.freeze(['claude.ai']) }),
  gemini: Object.freeze({ id: 'gemini', label: 'Gemini', hosts: Object.freeze(['gemini.google.com']) }),
});

/** @param {string} id */
export function getProvider(id) {
  return Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null;
}

/** @param {string} hostname A hostname, not an arbitrary URL. */
export function detectProvider(hostname) {
  if (typeof hostname !== 'string') return null;
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  return Object.values(PROVIDERS).find((provider) => provider.hosts.includes(normalized)) ?? null;
}
