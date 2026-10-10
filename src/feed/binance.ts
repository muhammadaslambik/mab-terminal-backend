export async function cachedFetch(
  key: string, url: string, ttlSeconds: number, env: Env
): Promise<any> {
  const hit = await env.CACHE.get(key, "json");
  if (hit) return { ...hit, _cached: true };

  const res = await fetch(url, { headers: { "User-Agent": "MAB-Terminal/1.0" } });
  if (!res.ok) throw new Error(`feed_{key}_status_{res.status}`);
  const data = await res.json();
  await env.CACHE.put(key, JSON.stringify(data), { expirationTtl: ttlSeconds });
  return data;
}

export async function binanceTickers(symbols: string[], env: Env) {
  const q = encodeURIComponent(JSON.stringify(symbols));
  return cachedFetch(
    `bin:tick24h`,
    `https://api.binance.com/api/v3/ticker/24hr?symbols=${q}`,
    15, // cache 15 detik — kuota aman
    env
  );
}
