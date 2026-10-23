# 03 — Spesifikasi Lengkap Fitur Legal Agent SaaS (Full Suite)

Tidak ada pemotongan MVP. Sistem langsung dibangun dan dirilis sebagai **Full Enterprise Legal Co-pilot** untuk praktisi hukum Indonesia (Solo Practitioner, Boutique Firm, & Corporate General Counsel).

---

## 4 Pilar Fungsional Utama (Full Scope)

### PILAR 1: Transaksional, Kontrak & Redline (Contract Intelligence)
1. **Surgical Contract Review & Redlining:**
   - Input: File DOCX / PDF draf perjanjian.
   - Pencocokan terhadap *Firm Playbook* (klausul standar kantor atau template industri).
   - Output: File **DOCX resmi dengan Microsoft Word Track Changes (`w:ins`, `w:del`)** dan **Word Comments (`w:comment`)** berbobot risiko (*Tinggi, Sedang, Rendah*).
   - Melindungi posisi tawar komersial klien (edit bedah minimal pada frasa berisiko, bukan rombak total kalimat).
2. **Contract History & Multi-Addendum Consolidation:**
   - Menghubungkan Kontrak Induk + Addendum 1, 2, 3, dst., serta Side Letters dalam satu garis waktu (*timeline*).
   - Menghasilkan **Consolidated Working Draft** (versi bersih yang berlaku saat ini).
3. **Contract Generator dari Nol:**
   - Drafting perjanjian komersial spesifik (PKS, NDA, Perjanjian Kerja Waktu Tertentu / PKWT, Perjanjian Pemegang Saham / SHA, Perjanjian Kerahasiaan, Perjanjian Pengikatan Jual Beli / PPJB).

---

### PILAR 2: Litigasi, Pembuktian & Berkas Sidang (Dispute Resolution)
1. **Litigation Drafter (Somasi & Berkas Perkara):**
   - **Surat Somasi / Teguran Hukum:** Draf somasi formal ke-1 dan ke-2 dengan dasar hukum wanprestasi (Pasal 1243 KUHPerdata) atau PMH (Pasal 1365 KUHPerdata) dan tenggat waktu kepatuhan yang wajar.
   - **Surat Gugatan:** Penyusunan sistematis: Identitas Para Pihak, Posita (*Fundamentum Petendi* berupa fakta peristiwa dan hubungan hukum), dan Petitum (Primer & Subsider/Ex Aequo Et Bono).
   - **Jawaban & Eksepsi:** Eksepsi Kompetensi Relatif/Absolut, *Obscuur Libel*, *Nebis In Idem*, dan Rekonvensi.
   - **Replik & Duplik:** Penajaman dalil bantahan.
2. **Matriks Pembuktian Sidang (Evidence Matrix):**
   - Pemetaan alat bukti surat (Bukti P-1 s/d P-N untuk Penggugat, T-1 s/d T-N untuk Tergugat).
   - Setiap bukti dipetakan ke nomor dalil posita yang dibuktikan, uraian fakta, relevansi yuridis, dan saksi/ahli pendukung.
3. **Grounded Judicial Precedents (Putusan Mahkamah Agung):**
   - Pencarian preseden yuridis dengan pemisahan tegas antara **Ratio Decidendi** (kaidah hukum mengikat amar) vs **Obiter Dicta** (pertimbangan pendukung).
   - Wajib mencantumkan nomor register perkara asli, tingkat pengadilan (PN/PT/Kasasi/PK), tahun, dan amar putusan resmi.

---

### PILAR 3: Korporasi, Kepatuhan & Due Diligence (Corporate & LDD)
1. **Bulk Data Room Analyzer (Legal Due Diligence - LDD):**
   - Ekstraksi massal puluhan hingga ratusan berkas dalam data room transaksi M&A atau pendanaan:
     - Akta Pendirian & Akta Perubahan Terakhir
     - SK Kemenkumham / Surat Penerimaan Pemberitahuan AHU
     - Izin Usaha / NIB OSS-RBA
     - Perjanjian Fasilitas Kredit Bank
     - Sertifikat Aset Tanah & Bangunan (SHM/HGB)
   - Output: **Matriks Due Diligence Komprehensif (Excel Spreadsheet via OpenPyXL)**:
     - Sheet 1: Executive Summary & Critical Legal Red Flags
     - Sheet 2: Struktur Kepemilikan Saham & Direksi/Komisaris Historis
     - Sheet 3: Checklist Perizinan OSS-RBA & Validitas Masa Berlaku
     - Sheet 4: Deteksi *Negative Covenants* (restriksi perubahan kepemilikan, pembagian dividen, atau penjaminan aset tanpa izin kreditur)
     - Sheet 5: Litigasi & Klaim Hukum Berjalan
2. **KBLI & OSS-RBA Compliance Checker:**
   - Verifikasi kesesuaian kode KBLI 5-digit perusahaan terhadap kegiatan operasional riil.
   - Cross-check terhadap Daftar Positif Investasi (Perpres 10/2021 jo. Perpres 49/2021): apakah terbuka untuk PMA 100%, dicadangkan untuk UMKM, atau bersyarat.

---

### PILAR 4: Opini Hukum & Analisis Mendalam (Advisory)
1. **Formal Legal Opinion (LO) & Legal Memo Builder:**
   - Draf Legal Opinion formal berstandar firma hukum papan atas:
     - **Bagian I:** Fakta-Fakta Hukum Terverifikasi (*Statement of Facts*)
     - **Bagian II:** Rumusan Masalah Yuridis (*Legal Issues Presented*)
     - **Bagian III:** Kerangka Hukum & Yurisprudensi Terkait (*Regulatory & Precedent Framework*)
     - **Bagian IV:** Analisis Yuridis Mendalam (*Substantive Legal Analysis*)
     - **Bagian V:** Kesimpulan & Rekomendasi Langkah Mitigasi (*Conclusions & Actionable Advice*)
2. **Adversarial Sparring & Devils Advocate:**
   - Partner diskusi hukum kritis untuk menguji kerapuhan dalil sebelum diajukan ke pengadilan atau meja negosiasi.
3. **High-Res OCR Akta & Berkas Perkara:**
   - Pemrosesan PDF hasil scan miring, stempel, materai, dan akta notaris lama menggunakan PyMuPDF + Tesseract OCR Bahasa Indonesia & Inggris.
