import type { TrustVerdict } from './standing';

/**
 * Sigvara for an agent framework's tools, with no framework as a dependency. LangChain is the worked
 * example: you pass in its `tool` function, so this SDK adds nothing to your install.
 *
 *     import { tool } from '@langchain/core/tools';
 *     const trust = new SigvaraTrustCheck({ rpcUrl, addresses, chainId: 5042002, minScore: 40 });
 *
 *     // A tool the model can call before dealing with another agent.
 *     const checkAgent = sigvaraTrustTool(tool, trust);
 *
 *     // A tool of yours that refuses to act for an agent without standing, whatever the model decided.
 *     const hire = tool(
 *       requireTrustedAgent(hireAgent, trust, (input) => input.agent),
 *       { name: 'hire_agent', description: 'Hire another agent', schema },
 *     );
 *
 * The second is the one to rely on. A model can be talked out of calling a check, and cannot be talked
 * out of a refusal in the code it calls.
 */

interface TrustCheck {
  check(agent: string): Promise<TrustVerdict>;
}

/** The input a trust tool takes, as JSON Schema, which LangChain's `tool` and most others accept. */
export const TRUST_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    agent: { type: 'string', description: 'The agent to check, as a 0x address' },
  },
  required: ['agent'],
  additionalProperties: false,
} as const;

/**
 * A tool the model can call to ask whether an agent has standing. `makeTool` is LangChain's `tool`, or
 * anything with its shape. Its answer is JSON: `ok`, and why not when it is false.
 */
export function sigvaraTrustTool<T>(
  makeTool: (
    fn: (input: { agent: string }) => Promise<string>,
    fields: { name: string; description: string; schema: typeof TRUST_TOOL_SCHEMA },
  ) => T,
  trust: TrustCheck,
  options: { name?: string; description?: string } = {},
): T {
  return makeTool(async ({ agent }) => JSON.stringify(await trust.check(agent)), {
    name: options.name ?? 'sigvara_check_agent',
    description: options.description
      ?? 'Check whether another AI agent has standing on Sigvara before paying it, hiring it or relying on it: '
       + 'that it is active, holds a slashable bond, and has a high enough score. Answers ok, and the reason when not.',
    schema: TRUST_TOOL_SCHEMA,
  });
}

export class UntrustedAgentError extends Error {
  readonly verdict: TrustVerdict;

  constructor(verdict: TrustVerdict) {
    super(`Refused: ${verdict.agent} ${verdict.reason}. ${verdict.detail ?? ''}`.trim());
    this.name = 'UntrustedAgentError';
    this.verdict = verdict;
  }
}

/**
 * `fn`, which runs only for an agent with standing and otherwise throws UntrustedAgentError. `agentFrom`
 * says which agent a call is about. A chain read that fails throws too, and `fn` does not run.
 */
export function requireTrustedAgent<I, R extends unknown[], O>(
  fn: (input: I, ...rest: R) => O | Promise<O>,
  trust: TrustCheck,
  agentFrom: (input: I) => string,
): (input: I, ...rest: R) => Promise<O> {
  return async (input, ...rest) => {
    const verdict = await trust.check(agentFrom(input));
    if (!verdict.ok) throw new UntrustedAgentError(verdict);
    return fn(input, ...rest);
  };
}
