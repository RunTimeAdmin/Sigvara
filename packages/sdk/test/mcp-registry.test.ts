import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The MCP Registry refuses a server.json whose name is not the published package's mcpName, and lists
// the version server.json names. Both are kept by hand beside package.json, so they are checked here.
const read = (f: string) => JSON.parse(readFileSync(join(__dirname, '..', f), 'utf8'));

describe('the MCP Registry listing', () => {
  const pkg = read('package.json');
  const server = read('server.json');

  it('names the package, its mcpName and its version', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toEqual([
      { registryType: 'npm', identifier: pkg.name, version: pkg.version, transport: { type: 'stdio' } },
    ]);
  });

  it('runs the one command the package installs', () => {
    // A registry client runs the package with npx and no command name, which works only while it has one.
    expect(Object.keys(pkg.bin)).toEqual(['sigvara-mcp']);
  });
});
