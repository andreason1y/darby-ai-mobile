# Legal Agent — `agent-computer`

Container worker sandbox untuk Legal Agent SaaS, berbasis Ubuntu 24.04 + Bun + Playwright Chromium, dengan toolchain pemrosesan dokumen hukum (DOCX, PDF, OCR) dan integrasi Centralized Legal Database.

---

## 1. Arsitektur & Toolchain yang Terpasang

- **Runtime Utama:** Bun 1.4.3 + Node 24 toolchain
- **Browser Automation:** Playwright Chromium 1.62.1 (Headless / Headed Virtual Display)
- **Document & Office Suite:**
  - `libreoffice-writer-nogui` & `libreoffice-calc-nogui` (headless document converter)
  - `poppler-utils` & `pandoc`
- **OCR Engine:**
  - `tesseract-ocr` + `tesseract-ocr-ind` (Bahasa Indonesia & English)
- **Isolated Python Virtualenv (`/opt/legal-tools-env`):**
  - `python-docx`: Manipulasi XML Word (Track Changes `w:ins`/`w:del`, Word Comments `w:comment`)
  - `pymupdf` (`fitz`): Ekstraksi teks & rendering halaman PDF berkecepatan tinggi
  - `openpyxl`: Pembuatan matriks due diligence / spreadsheet risiko
  - `httpx` & `pydantic`: HTTP client terstruktur untuk Centralized Legal DB API

---

## 2. CLI Tools di `tools/`

Semua script dapat dijalankan via CLI maupun dipanggil oleh endpoint server:

### A. `tools/contract_redline.py`
Mereview kontrak DOCX terhadap file playbook JSON dan menghasilkan file DOCX baru dengan Track Changes resmi Microsoft Word serta komentar risiko.

```bash
/opt/legal-tools-env/bin/python tools/contract_redline.py \
  --input /workspace/perjanjian.docx \
  --playbook /workspace/playbook_standar.json \
  --output /workspace/perjanjian_redlined.docx \
  --author "Legal AI Agent" \
  --json
```

**Format Playbook JSON:**
```json
{
  "author": "Legal AI Agent",
  "required_clauses": [
    {
      "id": "confidentiality",
      "title": "Klausul Kerahasiaan",
      "keywords": ["kerahasiaan", "confidential"],
      "suggested_text": "PASAL KERAHASIAAN\nPara Pihak wajib menjaga kerahasiaan...",
      "reason": "Kontrak komersial wajib memuat klausul kerahasiaan.",
      "severity": "high"
    }
  ],
  "forbidden_clauses": [
    {
      "id": "unlimited-liability",
      "title": "Tanggung Jawab Tanpa Batas",
      "patterns": ["tanggung jawab tanpa batas", "ganti rugi tanpa batas"],
      "reason": "Batasi tanggung jawab maksimal senilai nilai kontrak.",
      "severity": "high"
    }
  ],
  "replacements": [
    {
      "id": "dispute-forum",
      "title": "Penyelesaian Sengketa",
      "find": "Pengadilan Negeri Jakarta Pusat",
      "replace": "Arbitrase BANI di Jakarta",
      "reason": "Standar kantor menggunakan forum arbitrase BANI.",
      "severity": "medium"
    }
  ]
}
```

### B. `tools/pdf_extractor.py`
Ekstraksi teks dari PDF teks reguler maupun PDF scan hasil pemindaian/kamera.

```bash
/opt/legal-tools-env/bin/python tools/pdf_extractor.py \
  --input /workspace/akta_notaris_scan.pdf \
  --output /workspace/akta_teks.txt \
  --lang ind+eng \
  --ocr auto \
  --dpi 300 \
  --json
```

### C. `tools/legal_db_client.py`
Query ke Centralized Legal Database API untuk mengambil Putusan MA dan regulasi perundang-undangan.

```bash
export LEGAL_DB_API_URL="https://api.legaldb.internal"
export LEGAL_DB_API_KEY="secret-key"

/opt/legal-tools-env/bin/python tools/legal_db_client.py search "wanprestasi sewa menyewa" \
  --scope putusan \
  --limit 5 \
  --json
```

---

## 3. Spesifikasi HTTP Endpoints

Server `agent-computer` dengerin di port `4100` dan diautentikasi via header `Authorization: Bearer <COMPUTER_TOKEN>`.

### 1. `POST /legal/redline`
Menjalankan review kontrak dan redlining terhadap file di dalam `/workspace`.

**Payload Request:**
```json
{
  "path": "kontrak_vendor.docx",
  "playbook": "playbook_standar.json",
  "output": "kontrak_vendor_redlined.docx",
  "author": "Senior Legal AI",
  "report": true
}
```

### 2. `POST /legal/ocr`
Mengekstrak teks dan metadata dari berkas PDF (reguler atau scan) di dalam `/workspace`.

**Payload Request:**
```json
{
  "path": "berkas_perkara.pdf",
  "output": "berkas_perkara.ocr.txt",
  "lang": "ind+eng",
  "ocr": "auto",
  "dpi": 300,
  "includeText": false
}
```

### 3. `POST /legal/search-db`
Pencarian putusan MA dan regulasi ke Centralized Legal DB.

**Payload Request:**
```json
{
  "query": "tanggung renteng direksi pailit",
  "scope": "all",
  "limit": 10,
  "filters": {
    "tahun_min": 2020
  }
}
```

### 4. `POST /legal/due-diligence`
Menjalankan audit data room M&A dan menghasilkan matriks due diligence multi-sheet (.xlsx).

**Payload Request:**
```json
{
  "input": "data_room_perusahaan",
  "output": "laporan_due_diligence.xlsx",
  "client": "PT Investor Sukses",
  "target": "PT Target Akuisisi",
  "reviewer": "Associate Legal Team"
}
```

### 5. `POST /legal/litigation-draft`
Penyusunan berkas perkara sidang resmi (Somasi, Gugatan, Matriks Bukti).

**Payload Request:**
```json
{
  "mode": "gugatan",
  "input": "kasus_wanprestasi.json",
  "output": "gugatan_wanprestasi.docx",
  "basis": "wanprestasi"
}
```

### 6. `POST /legal/opinion-memo`
Pembuatan Legal Opinion Memo formal 5 bagian standar firma hukum.

**Payload Request:**
```json
{
  "input": "analisis_opini.json",
  "output": "legal_opinion_memo.docx"
}
```
