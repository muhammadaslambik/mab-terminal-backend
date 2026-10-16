"""
Kolektor intel cacing-naga (Andry Hakim v2), MANDIRI, dijalankan di PC rumah (IDX memblokir IP cloud).

  python collect_intel.py --smoke                      uji kecil
  python collect_intel.py                              pindai penuh (~150 request)
  python collect_intel.py --from-worker --push         ambil daftar kode dari /api/idx/cacing, proses hanya itu, kirim ke Worker
  python collect_intel.py --codes BBSS,RIGS --push     daftar kode manual

Token Worker: variabel lingkungan MAB_TOKEN, atau file %USERPROFILE%\\.mab_prod_token. Tidak pernah dicetak.
Hasilnya DAFTAR PANTAUAN, bukan sinyal beli.
Publik = Masyarakat Non Warkat. Owner = semua pemegang lain selain Non Warkat dan treasury.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timedelta

from idx.core.client import IDXClient
from idx.scrapers.company import fetch_company_detail
from idx.scrapers.financial import QUERY_PARAMS

# ---- Konstanta (samakan dengan an4_andry_hakim.ts) ----
DER_MAX = 0.1
PUBLIC_MAX_PCT = 30.0
OWNER_MIN_PCT = 70.0
OWNER_MAX_PCT = 99.0
FS_MAX_AGE_DAYS = 183
ANN_MAX_AGE_DAYS = 180
MAX_EMITEN = 60
MAX_DETAIL = 150             # pagar jumlah request detail (mode pindai)
MAX_CODES = 60               # pagar mode --codes
SMOKE_DETAIL = 5
BLOCK_AFTER = 3              # gagal beruntun (tiap kali sudah diulang) -> anggap diblokir, berhenti
SLEEP_S = float(os.environ.get("COLLECT_SLEEP", "1.0"))
WORKER_URL = os.environ.get("MAB_WORKER_URL", "https://api.mab-terminal.workers.dev").rstrip("/")
FIN_URL = "/DigitalStatistic/GetApiDataPaginated"
ANN_URL = "/NewsAnnouncement/GetAllAnnouncement"

STRONG = re.compile(
    r"akuisisi|pengambilalihan|penambahan modal|private placement|penempatan terbatas|"
    r"fakta material|perubahan pengendali|penyertaan|penjualan aset|pembelian aset|"
    r"transaksi material|perubahan kegiatan usaha|setoran modal|konversi",
    re.I,
)
WEAK = re.compile(
    r"rapat umum pemegang saham luar biasa|rupslb|insidentil|perjanjian|kerja sama|investor",
    re.I,
)
EXCLUDE = re.compile(r"tahunan|registrasi pemegang efek|laporan bulanan", re.I)
CODE_RE = re.compile(r"^[A-Z0-9]{2,6}$")


class Blocked(Exception):
    pass


_fails = 0


def pause():
    if SLEEP_S > 0:
        time.sleep(SLEEP_S)


def call(fn, *a, retries=1, **kw):
    """Panggil dengan ulang. None bila gagal. Berhenti (Blocked) bila gagal BLOCK_AFTER kali beruntun."""
    global _fails
    for i in range(retries + 1):
        try:
            r = fn(*a, **kw)
            if r is not None:
                _fails = 0
                return r
        except Exception:
            pass
        if i < retries and SLEEP_S > 0:
            time.sleep(2)
    _fails += 1
    if _fails >= BLOCK_AFTER:
        raise Blocked(f"{_fails} request beruntun gagal, IDX kemungkinan memblokir IP ini")
    return None


# ---------------- Worker ----------------
def worker_token():
    t = os.environ.get("MAB_TOKEN")
    if t and t.strip():
        return t.strip()
    p = os.path.join(os.path.expanduser("~"), ".mab_prod_token")
    if os.path.exists(p):
        with open(p, encoding="utf-8-sig") as f:
            t = f.read().strip()
        if t:
            return t
    raise RuntimeError("Token Worker tidak ditemukan (set MAB_TOKEN atau buat %USERPROFILE%\\.mab_prod_token)")


def worker_call(method, path, body=None):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        WORKER_URL + path, data=data, method=method,
        headers={
            "Authorization": "Bearer " + worker_token(),
            "Content-Type": "application/json",
            "User-Agent": "mab-collector/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Worker menjawab HTTP {e.code} untuk {method} {path}")


# ---------------- IDX ----------------
def fin_page(client, y, q, page, size=100):
    p = {**QUERY_PARAMS, "periodQuarter": q, "periodYear": y, "type": "quarterly",
         "pageSize": size, "pageNumber": page}
    d = call(client.get_json, FIN_URL, params=p)
    if d is None:
        return None
    return d.get("data") or []


def pick_period(client, today):
    """Cari periode terbaru yang mayoritas emitennya sudah lapor. Param kuartal bergeser satu
    (Q3 = 30 Jun, Q2 = 31 Mar, Q1 = 31 Des)."""
    answered = False
    for yy in (today.year, today.year - 1):
        for q in (4, 3, 2, 1):
            rows = fin_page(client, yy, q, 1)
            pause()
            if rows is None:
                continue
            answered = True
            if not rows:
                continue
            mode, n = Counter(r.get("fsDate") for r in rows).most_common(1)[0]
            if n >= 50:
                return yy, q, mode
    raise RuntimeError(
        "IDX tidak menjawab (kemungkinan diblokir)" if not answered
        else "Tidak ada periode keuangan dengan data memadai"
    )


def fetch_fin_all(client, y, q, smoke, want=None):
    """Ambil halaman keuangan. Bila `want` (set kode) diberikan, berhenti begitu semuanya ditemukan."""
    out, page, found = [], 1, set()
    while True:
        rows = fin_page(client, y, q, page)
        if not rows:
            break
        out.extend(rows)
        print(f"  keuangan halaman {page}: {len(rows)} (total {len(out)})")
        if smoke:
            break
        if want:
            found |= {(r.get("code") or "").strip() for r in rows} & want
            if found >= want:
                break
        page += 1
        pause()
    return out


def stage_structure(fin_rows, today):
    cutoff = today - timedelta(days=FS_MAX_AGE_DAYS)
    cands, why = [], {"der": 0, "usang": 0}
    for r in fin_rows:
        code = (r.get("code") or "").strip()
        der = r.get("deRatio")
        if not code or der is None or not (0 <= der <= DER_MAX):
            why["der"] += 1
            continue
        try:
            fs = datetime.strptime(r["fsDate"], "%Y-%m-%d")
        except Exception:
            why["usang"] += 1
            continue
        if fs < cutoff:
            why["usang"] += 1
            continue
        cands.append(r)
    return cands, why


# Persentase publik/owner dihitung dari saham BEREDAR (tanpa treasury). Samakan dengan TREASURY_EXCLUDED_FROM_BASE di cacing_screen.ts.
TREASURY_EXCLUDED = True
TOTAL_TOL = 1.5          # jumlah seluruh baris pemegang harus 100 +/- ini, bila tidak komposisi dianggap tidak lengkap
DETAIL_ATTEMPTS = 3
INTEL_SCHEMA = 2
_NOT_NAMED = ("Masyarakat Non Warkat", "Masyarakat Warkat", "Saham Treasury")


def _pct(r):
    return r.get("Persentase") or 0


def _public_name(r):
    return str(r.get("Nama") or "").strip().lower().startswith("masyarakat")


def composition(detail):
    """Pecah komposisi pemegang saham.
    publik = Masyarakat Non Warkat + baris >5% bernama 'Masyarakat' (publik terkonsolidasi, mis. KIOS 59,7%).
    owner  = semua baris lain selain treasury (termasuk Masyarakat Warkat, Komisaris, Direksi)."""
    rows = detail.get("PemegangSaham") or []
    nonw = sum(_pct(r) for r in rows if r.get("Kategori") == "Masyarakat Non Warkat")
    warkat = sum(_pct(r) for r in rows if r.get("Kategori") == "Masyarakat Warkat")
    treasury = sum(_pct(r) for r in rows if r.get("Kategori") == "Saham Treasury")
    big_pub = sum(_pct(r) for r in rows if r.get("Kategori") not in _NOT_NAMED and _public_name(r))
    total = sum(_pct(r) for r in rows)
    owner = total - nonw - treasury - big_pub
    named = [r for r in rows if r.get("Kategori") not in _NOT_NAMED and not _public_name(r) and _pct(r) > 0]
    top = max(named, key=_pct, default=None)
    holders = sorted((r for r in rows if _pct(r) >= 1), key=_pct, reverse=True)[:10]
    base = (100 - treasury) if TREASURY_EXCLUDED else 100
    return {
        "nonw": nonw, "warkat": warkat, "treasury": treasury, "big_pub": big_pub, "total": total, "owner": owner,
        "top": top, "holders": holders,
        "complete": bool(rows) and abs(total - 100) <= TOTAL_TOL,
        "pub_adj": ((nonw + big_pub) / base * 100) if base > 0 else None,
        "owner_adj": (owner / base * 100) if base > 0 else None,
    }


def _r2(x):
    return None if x is None else round(x, 2)


def fetch_detail_complete(client, code):
    """Ambil detail emiten; ulangi bila komposisi tidak berjumlah ~100% (respons IDX kadang kehilangan baris)."""
    last = None
    for i in range(DETAIL_ATTEMPTS):
        d = call(fetch_company_detail, code, client=client)
        if d is None:
            break  # gagal total (call sudah mengulang sekali): jangan hitung lagi sebagai kegagalan beruntun
        last = d
        if composition(d)["complete"]:
            return d
        if i < DETAIL_ATTEMPTS - 1:
            pause()
    return last


def build_item(r, detail):
    """Item lengkap plus `checks` (True/False/None=tidak bisa dinilai). Komposisi tidak lengkap -> checks publik/owner None."""
    c = composition(detail) if detail and detail.get("PemegangSaham") else None
    ok = bool(c and c["complete"])
    der = r.get("deRatio")
    top = c["top"] if c else None
    pa, oa = (c["pub_adj"], c["owner_adj"]) if ok else (None, None)
    return {
        "schema": INTEL_SCHEMA,
        "code": (r.get("code") or "").strip(),
        "name": r.get("stockName"),
        "sector": r.get("sector"),
        "fsDate": r.get("fsDate"),
        "der": der,
        "assetsBn": r.get("assets"),
        "liabilitiesBn": r.get("liabilities"),
        "equityBn": r.get("equity"),
        "profitPeriodBn": r.get("profitPeriod"),
        "audited": r.get("audit"),
        "publicNonWarkatPct": _r2(c["nonw"]) if c else None,
        "publicBigPct": _r2(c["big_pub"]) if c else None,
        "publicWarkatPct": _r2(c["warkat"]) if c else None,
        "ownerTotalPct": _r2(c["owner"]) if c else None,
        "treasuryPct": _r2(c["treasury"]) if c else None,
        "holdersTotalPct": _r2(c["total"]) if c else None,
        "complete": ok if c else None,
        "adjustedPublicPct": _r2(pa),
        "adjustedOwnerPct": _r2(oa),
        "topHolder": {
            "name": (top or {}).get("Nama"),
            "pct": (top or {}).get("Persentase"),
            "controller": bool((top or {}).get("Pengendali")),
        },
        "holders": [{"kategori": h.get("Kategori"), "nama": h.get("Nama"), "pct": h.get("Persentase"),
                     "controller": bool(h.get("Pengendali"))} for h in (c["holders"] if c else [])],
        "checks": {
            "der": None if der is None else (0 <= der <= DER_MAX),
            "public": None if pa is None else (_r2(pa) <= PUBLIC_MAX_PCT),
            "owner": None if oa is None else (OWNER_MIN_PCT <= _r2(oa) <= OWNER_MAX_PCT),
        },
    }


def stage_holders(r, detail):
    """Mode pindai. Kembalikan (item, alasan_gugur)."""
    item = build_item(r, detail)
    c = item["checks"]
    if c["public"] is None:
        return None, "tanpa_detail"
    if not c["public"]:
        return None, "publik"
    if not c["owner"]:
        return None, "owner"
    return item, None


def fetch_announcements(client, code, today):
    d = call(client.get_json, ANN_URL,
             params={"keywords": code, "pageNumber": 1, "pageSize": 50, "lang": "id"})
    cutoff = today - timedelta(days=ANN_MAX_AGE_DAYS)
    res = []
    for it in (d or {}).get("Items") or []:
        if (it.get("Code") or "").strip() != code:
            continue
        title = (it.get("Title") or "").strip()
        if EXCLUDE.search(title):
            continue
        level = "kuat" if STRONG.search(title) else ("lemah" if WEAK.search(title) else None)
        if level is None:
            continue
        try:
            when = datetime.fromisoformat(it["PublishDate"])
        except Exception:
            continue
        if when < cutoff:
            continue
        main_pdf = next((a for a in it.get("Attachments") or [] if a.get("IsAttachment") == 0), None)
        res.append({"date": it["PublishDate"], "level": level, "title": title,
                    "no": it.get("AnnouncementNo"), "pdf": (main_pdf or {}).get("FullSavePath")})
    return res


def resolve_codes(args):
    if args.codes:
        raw = [c.strip().upper() for c in args.codes.split(",") if c.strip()]
    else:
        print("Mengambil daftar kandidat dari Worker...")
        d = worker_call("GET", "/api/idx/cacing")
        raw = [str(c.get("code", "")).strip().upper() for c in (d.get("candidates") or [])]
    codes = []
    for c in raw:
        if CODE_RE.match(c) and c not in codes:
            codes.append(c)
    if not codes:
        raise RuntimeError("Daftar kode kosong atau tidak valid")
    if len(codes) > MAX_CODES:
        print(f"Peringatan: dibatasi {MAX_CODES} kode.")
        codes = codes[:MAX_CODES]
    return codes


def save(out, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("Tersimpan:", path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="uji kecil")
    ap.add_argument("--out", default="intel.json")
    ap.add_argument("--codes", help="daftar kode dipisah koma, melewati saringan DER/usia")
    ap.add_argument("--from-worker", action="store_true", help="ambil daftar kode dari /api/idx/cacing")
    ap.add_argument("--push", action="store_true", help="kirim hasil ke Worker (POST /api/intel)")
    ap.add_argument("--missing-only", action="store_true", help="lewati kode yang sudah punya intel di Worker (GET /api/intel)")
    args = ap.parse_args()

    codes_mode = bool(args.codes or args.from_worker)
    if args.push and args.smoke:
        print("GAGAL: --push tidak boleh bersama --smoke")
        return 2
    codes = None
    if codes_mode:
        try:
            codes = resolve_codes(args)
        except RuntimeError as e:
            print("GAGAL:", e)
            return 2
        print(f"Mode kode: {len(codes)} emiten: {','.join(codes)}")
        if args.missing_only:
            try:
                # "sudah ada" = intel skema terbaru DAN komposisi lengkap; data lama/tidak lengkap dianggap belum ada
                have = {i.get("code") for i in (worker_call("GET", "/api/intel").get("items") or [])
                        if i.get("schema") == INTEL_SCHEMA and i.get("complete") is True}
            except RuntimeError as e:
                if "HTTP 404" not in str(e):
                    print("GAGAL:", e)
                    return 2
                have = set()
            skipped = [c for c in codes if c in have]
            codes = [c for c in codes if c not in have]
            print(f"--missing-only: {len(skipped)} kode sudah punya intel valid dilewati, {len(codes)} diproses: {','.join(codes)}")
            if not codes:
                print("Tidak ada kode baru.")
                return 0
    if args.push:
        try:
            worker_token()  # gagal cepat sebelum 50 request ke IDX
        except RuntimeError as e:
            print("GAGAL:", e)
            return 2

    client = IDXClient()
    today = datetime.now()
    items, missing, period = [], [], {}
    out = {
        "collectedAt": today.isoformat(timespec="seconds"),
        "mode": "codes" if codes_mode else "scan",
        "smoke": bool(args.smoke),
        "publicDefinition": "Masyarakat Non Warkat",
        "note": "Daftar pantauan. Market cap < Rp500 M diperiksa di Worker. Nilai transaksi dan dana masuk dibaca manual dari PDF.",
    }
    try:
        y, q, fs_mode = pick_period(client, today)
        period = {"periodYear": y, "periodQuarter": q, "fsDate": fs_mode}
        print(f"Periode terpilih: periodYear={y} periodQuarter={q} (fsDate dominan {fs_mode})")

        if codes_mode:
            want = set(codes)
            fin_rows = fetch_fin_all(client, y, q, False, want=want)
            by_code = {(r.get("code") or "").strip(): r for r in fin_rows}
            for n, code in enumerate(codes, 1):
                r = by_code.get(code)
                if r is None:
                    missing.append(code)
                    r = {"code": code}
                detail = fetch_detail_complete(client, code)
                item = build_item(r, detail)
                pause()
                item["announcements"] = fetch_announcements(client, code, today)
                items.append(item)
                print(f"  [{n}/{len(codes)}] {code}: struktur {item['checks']} | {len(item['announcements'])} pengumuman relevan")
                pause()
        else:
            fin_rows = fetch_fin_all(client, y, q, args.smoke)
            cands, why = stage_structure(fin_rows, today)
            print(f"Emiten keuangan: {len(fin_rows)} | lolos DER dan usia: {len(cands)} | gugur: {why}")
            cands = cands[: (SMOKE_DETAIL if args.smoke else MAX_DETAIL)]

            why2 = {"tanpa_detail": 0, "publik": 0, "owner": 0}
            for n, r in enumerate(cands, 1):
                code = (r.get("code") or "").strip()
                detail = fetch_detail_complete(client, code)
                item, reason = stage_holders(r, detail)
                if item:
                    items.append(item)
                else:
                    why2[reason] += 1
                print(f"  [{n}/{len(cands)}] {code}: {'LOLOS' if item else 'gugur ' + reason}")
                pause()
            print(f"Lolos struktur: {len(items)} | gugur: {why2}")

            items.sort(key=lambda x: x["publicNonWarkatPct"])
            if len(items) > MAX_EMITEN:
                print(f"Peringatan: dibatasi {MAX_EMITEN} (urut publik terkecil).")
                items = items[:MAX_EMITEN]
            for n, it in enumerate(items, 1):
                it["announcements"] = fetch_announcements(client, it["code"], today)
                print(f"  [{n}/{len(items)}] {it['code']}: {len(it['announcements'])} pengumuman relevan")
                pause()
    except Blocked as e:
        print("BERHENTI:", e)
        out.update({"partial": True, "financialPeriod": period, "items": items})
        save(out, args.out)
        valid = [it for it in items if it.get("complete") is True]  # hanya yang komposisinya lengkap; Worker menggabungkan per kode
        if args.push and valid:
            try:
                res = worker_call("POST", "/api/intel", {**out, "items": valid})
                print(f"Sebagian: {len(valid)} emiten lengkap dikirim ke Worker:", {k: res.get(k) for k in ("ok", "accepted", "total", "updatedAt")})
            except RuntimeError as e2:
                print("GAGAL kirim sebagian:", e2)
        elif args.push:
            print("Sebagian: belum ada emiten lengkap untuk dikirim.")
        print("Lanjutkan nanti dengan --missing-only (tunggu beberapa menit; pertimbangkan COLLECT_SLEEP=3).")
        return 2
    except RuntimeError as e:
        print("GAGAL:", e)
        return 2

    out.update({"partial": False, "financialPeriod": period, "missingFinancial": missing, "items": items})
    save(out, args.out)

    if args.push:
        try:
            res = worker_call("POST", "/api/intel", out)
            print("Terkirim ke Worker:", {k: res.get(k) for k in ("ok", "accepted", "total", "updatedAt")})
        except RuntimeError as e:
            print("GAGAL kirim:", e, "(berkas lokal tetap tersimpan)")
            return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
