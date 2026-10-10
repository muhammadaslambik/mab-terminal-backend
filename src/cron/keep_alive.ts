export async function handleKeepAlive(env: any, ctx: any): Promise<void> {
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.log("[Keep-Alive] Gagal mengeksekusi ping: Variabel lingkungan tidak ditemukan.");
    return;
  }

  ctx.waitUntil(
    Promise.all([
      // 1. Lakukan ping ringan ke REST API Supabase untuk mencegah Auto-Pause
      fetch(`${supabaseUrl}/rest/v1/`, {
        headers: { "apikey": supabaseKey, "Authorization": `Bearer ${supabaseKey}` }
      }).then((res) => {
        console.log(`[Keep-Alive] Supabase Cloud Ping Status: ${res.status}`);
      }),

      // 2. Jika Anda menyambungkan Neon Postgres HTTP API nantinya
      env.NEON_DATABASE_URL ? fetch(env.NEON_DATABASE_URL).catch(() => {}) : Promise.resolve()
    ]).then(() => {
      console.log(`[${new Date().toISOString()}] Aktivitas terjadwal berhasil dikirim. Database dipastikan Always-On.`);
    })
  );
}
