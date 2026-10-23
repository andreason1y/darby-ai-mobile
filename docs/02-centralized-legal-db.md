# 02 — Centralized Legal Database (The Proprietary Moat)

Dokumen ini menjelaskan strategi pembangunan dan pemanfaatan Database Hukum Terpusat sebagai fondasi utama riset hukum berbasis AI (Grounded Legal Research).

---

## 1. Problem Scraping Publik di Runtime

Bergantung pada live scraping portal pemerintah (Direktori Putusan Mahkamah Agung, JDIH Kemenkumham, BPS, OJK, AHU) saat agent sedang melayani permintaan user memiliki kelemahan fatal:
1. **WAF & IP Blocking:** Portal publik sering memasang Perimeter WAF (Cloudflare challenge, 403 Forbidden, rate limit).
2. **Infrastruktur Tidak Stabil:** Portal pemerintah sering down, lambat, atau mengubah struktur HTML secara mendadak.
3. **Latency Tinggi:** Mengunduh dan mem-parsing puluhan PDF putusan (50-200 halaman per berkas) secara on-the-fly menyebabkan timeout pada antarmuka chat.

---

## 2. Solusi: Database Hukum Terkurasi Sendiri (R2 + Vector Store)

Kami membangun **Corpus Hukum Terpusat** milik sendiri yang di-hosting pada infrastruktur cloud mandiri:

- **Object Storage (Cloudflare R2):**
  - Menyimpan salinan berkas asli (Raw PDF/DOCX) dari Putusan MA, Naskah Akademik, dan Lembaran Negara.
  - Zero egress cost, memudahkan download/streaming dokumen berukuran masif.
- **Structured Metadata Storage (PostgreSQL / SQLite):**
  - Metadata terindeks: Nomor Putusan, Tanggal Putusan, Tingkat Peradilan (PN/PT/Kasasi/PK), Klasifikasi Perkara, Nama Hakim/Majelis, Amar Putusan, dan Kaidah Hukum.
  - Untuk Regulasi: Nomor UU/PP/Permen, Tahun, Status Berlaku/Dicabut, Hubungan Perubahan.
- **Vector Search & Hybrid Retrieval:**
  - Embedding teks pasal dan pertimbangan hukum hakim menggunakan model embedding multibahasa yang dioptimasi untuk terminologi hukum.
  - Hybrid Search: Full-Text Search (BM25/FTS5) untuk pencocokan nomor pasal/klausa eksak + Semantic Search untuk pencarian konsep/isu hukum serupa.

---

## 3. Peran Agent: DB Terpusat vs Agent Roaming

```
[User Request]
       │
       ▼
[Legal Agent Orchestrator]
       │
       ├─► (Jalur Utama - 90%) ──► [Internal Legal DB API / MCP]
       │                          ├─ Putusan MA Terverifikasi
       │                          ├─ Regulasi & UU Lengkap
       │                          └─ Sitasi Eksak & Tanpa Halusinasi
       │
       └─► (Jalur Pelengkap - 10%) ─► [Headless Playwright Chromium]
                                  ├─ Roaming info terkini (berita perkara hari ini)
                                  ├─ Verifikasi status AHU Online live
                                  └─ Cek regulasi yang baru diundangkan < 24 jam
```

1. **Jalur Utama (Internal DB):** Agent memanggil tool internal yang terhubung ke database R2. Menghasilkan jawaban berdasar pasal otentik dengan sitasi nomor putusan dan tautan dokumen PDF asli.
2. **Jalur Pelengkap (Agent Roaming):** Hanya diaktifkan jika informasi yang dicari memerlukan data real-time detik itu juga atau verifikasi status kepemilikan/badan hukum di portal publik.

---

## 4. Benchmark & Analisis Kompetitor Lokal

- **Legal Hero (`com.legalhero`):**
  - Memiliki klaim 5 juta+ dokumen hukum terindeks.
  - Alur query dan model payload pencariannya akan dibedah menggunakan REA (Reverse Engineering) untuk memetakan taksonomi filter perkara (pidana, perdata, niaga, PHI, TUN) dan struktur respons JSON-nya.
- **Hukumonline PRO AI & Veritask (AiYU):**
  - Menjadikan data regulasi terstruktur sebagai *moat* bisnis dengan harga langganan korporat mencapai puluhan hingga ratusan juta rupiah per tahun.
  - Membuktikan bahwa nilai jual SaaS bukan sekadar bot AI-nya, melainkan keabsahan dan kebersihan data hukum di belakangnya.
