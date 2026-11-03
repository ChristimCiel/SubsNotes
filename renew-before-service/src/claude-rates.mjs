// The request is deliberately independent of the user's finances or preferences.
export function createClaudeRatesClient(mcp, fx, { clock = () => new Date() } = {}) {
  return {
    async load() {
      if (!mcp?.callTool) throw new Error('Public exchange-rate connector is unavailable');
      const result = await mcp.callTool('Frankfurter', 'get_rates', { base: 'USD' }, { cache: false });
      if (result?.isError || result?.error) throw new Error('Exchange-rate connector reported an error');
      let data = result?.payload ?? result?.structuredContent;
      if (data === undefined && Array.isArray(result?.content)) data = result.content.find(x => x.type === 'text')?.text;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { throw new Error('Unsupported exchange-rate response'); }
      }
      return { snapshot: fx.normalizeRates(data, 'frankfurter', clock()), cached: false, offline: false };
    }
  };
}
