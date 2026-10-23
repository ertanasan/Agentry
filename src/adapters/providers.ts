export const AGENTS = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", antigravity: "Antigravity CLI" } as const;
export type AgentId = keyof typeof AGENTS;
export function isAgent(value: string): value is AgentId { return Object.hasOwn(AGENTS, value); }
