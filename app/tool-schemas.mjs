// The pinned filesystem server emits Draft 7 dialect hints. Its schemas use
// keywords shared with JSON Schema 2020-12, which is MCP's default dialect.
// Omit the legacy hint on input AND output schemas so current Claude clients
// can compile them. Keep all argument and result validation constraints.
export function compatibleToolDefinitions(result) {
  return {
    ...result,
    tools: result.tools.map(tool => {
      const compatible = { ...tool };
      for (const field of ['inputSchema', 'outputSchema']) {
        if (!tool[field]) continue;
        compatible[field] = structuredClone(tool[field]);
        if (compatible[field].$schema === 'http://json-schema.org/draft-07/schema#') {
          delete compatible[field].$schema;
        }
      }
      return compatible;
    }),
  };
}
