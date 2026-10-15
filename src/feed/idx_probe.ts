// Uji apakah IDX bisa dijangkau dari Cloudflare Worker (bukan dari PC atau GitHub).
// Hanya 3 request kecil. Jalankan pada Worker yang sudah di-deploy, bukan wrangler dev lokal.

const BASE = "https://www.idx.co.id/primary";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
  Referer: "https://www.idx.co.id/",
};

export interface IdxProbeItem {
  name: string;
  ok: boolean;
  status: number | null;
  contentType: string | null;
  challenge: boolean;
  keys: string[];
  count: number | null;
  sample: string;
  error: string | null;
}

async function probeOne(name: string, path: string): Promise<IdxProbeItem> {
  try {
    const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
    const text = await res.text();
    const challenge = /just a moment|cf-chl|attention required|enable javascript/i.test(text.slice(0, 3000));
    let keys: string[] = [];
    let count: number | null = null;
    try {
      const j: any = JSON.parse(text);
      keys = Object.keys(j).slice(0, 8);
      const arr = j.data ?? j.Items ?? j.Profiles;
      count = Array.isArray(arr) ? arr.length : null;
    } catch {
      // bukan JSON (kemungkinan halaman tantangan)
    }
    return {
      name,
      ok: res.ok && !challenge && keys.length > 0,
      status: res.status,
      contentType: res.headers.get("content-type"),
      challenge,
      keys,
      count,
      sample: text.slice(0, 120).replace(/\s+/g, " "),
      error: null,
    };
  } catch (e) {
    return { name, ok: false, status: null, contentType: null, challenge: false, keys: [], count: null, sample: "", error: String(e) };
  }
}

export async function probeIdx(): Promise<{ allOk: boolean; results: IdxProbeItem[] }> {
  const results: IdxProbeItem[] = [];
  results.push(
    await probeOne(
      "keuangan",
      "/DigitalStatistic/GetApiDataPaginated?urlName=LINK_FINANCIAL_DATA_RATIO&periodQuarter=3&periodYear=2026&type=quarterly&isPrint=false&cumulative=false&pageSize=3&pageNumber=1&orderBy=&search="
    )
  );
  results.push(await probeOne("pengumuman", "/NewsAnnouncement/GetAllAnnouncement?keywords=IGAR&pageNumber=1&pageSize=3&lang=id"));
  results.push(await probeOne("detail", "/ListedCompany/GetCompanyProfilesDetail?KodeEmiten=IGAR&language=id-id"));
  return { allOk: results.every((r) => r.ok), results };
}
